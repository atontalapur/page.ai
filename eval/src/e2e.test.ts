import { join } from 'node:path';
import type { Tier } from '@page/contracts';
import { AGENT_BRANCH_PREFIX, type PullRequest } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import {
  defaultBudget,
  defaultExpectation,
  defaultTimeouts,
  formatMs,
  issueTitleMatches,
  parseDrain,
  parseDuration,
  parseTimeouts,
  prepareTarget,
  reportErrorLine,
  runE2E,
  stepTimeouts,
  summarize,
  type Clock,
  type E2EApproval,
  type E2EOptions,
  type E2EResult,
  type GitHubReader,
  type IssueRow,
  type PipelineControl,
  type PipelineReader,
  type RunApprover,
  type RunProgress,
  type Target,
  type TimedStep,
} from './e2e.ts';
import { containerStopped, localAppUrl, waitHealthy } from './e2e-app.ts';
import { loadScenario, type Scenario } from './scenario.ts';
import { loadSplit } from './split.ts';

const S = 1000;
const MIN = 60 * S;
const TITLE = 'RangeError: Invalid currency code : US';

const scenario = (expectedTier: Tier = 1, kind: Scenario['kind'] = 'code'): Scenario => ({
  id: '001-bad-currency-code',
  dir: 'scenarios/001-bad-currency-code',
  kind,
  meta: {
    class: 'frontend',
    expectedTier,
    description: 'd',
    report: `GET / returned 500\n\n${TITLE}\n    at new NumberFormat (<anonymous>)`,
  },
});

/**
 * Virtual time. A sleep fires once everything else in flight has settled (the next
 * macrotask), earliest timer first, and moves the clock to its due time. A cancelled
 * sleep never fires, so a timeout that lost its race doesn't move the clock.
 */
class FakeClock implements Clock {
  t = Date.UTC(2026, 10, 15);
  private timers: { at: number; seq: number; fire: () => void }[] = [];
  private seq = 0;
  private scheduled = false;

  now(): number {
    return this.t;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason as Error);
      const timer = { at: this.t + ms, seq: this.seq++, fire: () => resolve() };
      this.timers.push(timer);
      signal?.addEventListener(
        'abort',
        () => {
          this.timers = this.timers.filter((t) => t !== timer);
          reject(signal.reason as Error);
        },
        { once: true },
      );
      this.schedule();
    });
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift();
      if (next === undefined) return;
      this.t = Math.max(this.t, next.at);
      next.fire();
      if (this.timers.length > 0) this.schedule();
    });
  }
}

const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000b2';
const R3 = '00000000-0000-4000-8000-0000000000c3';
const ISSUE = '00000000-0000-4000-8000-000000000001';

/** One change to the fake pipeline, `at` ms after the trigger. */
interface Change {
  at: number;
  apply: (world: World) => void;
}

/**
 * The orchestrator database and the demo repo as the harness sees them. Changes apply as
 * the clock passes them, counted from when the trigger ran.
 */
class World {
  issues: IssueRow[] = [];
  runs = new Map<string, RunProgress>();
  prs = new Map<string, PullRequest>();
  closed: number[] = [];
  killed: string[] = [];
  /** Kills and PR closes, in order. */
  writes: string[] = [];
  triggeredAt: number | null = null;
  readErrors = 0;
  readonly clock: FakeClock;
  private changes: Change[];

  constructor(clock: FakeClock, changes: Change[]) {
    this.clock = clock;
    this.changes = changes;
  }

  tick() {
    if (this.triggeredAt === null) return;
    const elapsed = this.clock.now() - this.triggeredAt;
    const due = this.changes.filter((c) => c.at <= elapsed);
    this.changes = this.changes.filter((c) => c.at > elapsed);
    for (const c of due) c.apply(this);
  }

  issue(): IssueRow {
    return this.issues[0]!;
  }

  run(id: string): RunProgress {
    let run = this.runs.get(id);
    if (run === undefined) {
      run = { runId: id, run: null, jobState: 'created', steps: 0, pendingApprovals: 0 };
      this.runs.set(id, run);
    }
    return run;
  }

  readonly reader: PipelineReader = {
    now: () => Promise.resolve(new Date(this.clock.now())),
    issuesSeenSince: (since) => {
      this.tick();
      if (this.readErrors > 0) {
        this.readErrors -= 1;
        return Promise.reject(new Error('connection refused'));
      }
      return Promise.resolve(
        this.issues.filter((i) => i.lastSeenAt >= since).map((i) => ({ ...i })),
      );
    },
    issue: (id) => {
      this.tick();
      const row = this.issues.find((i) => i.id === id);
      return Promise.resolve(row === undefined ? null : { ...row });
    },
    run: (runId) => {
      this.tick();
      return Promise.resolve({ ...this.run(runId) });
    },
    // The fake has one issue, so every run is its.
    runIdsForIssue: (id) =>
      Promise.resolve(this.issues.some((i) => i.id === id) ? [...this.runs.keys()] : []),
  };

  readonly control: PipelineControl = {
    killIssue: (id) => {
      this.killed.push(id);
      this.writes.push(`kill ${id}`);
      const row = this.issues.find((i) => i.id === id);
      if (row !== undefined) row.status = 'killed';
      return Promise.resolve();
    },
  };

  readonly github: GitHubReader = {
    findOpenPullRequest: (head) => {
      this.tick();
      return Promise.resolve(this.prs.get(head) ?? null);
    },
    closePullRequest: (number) => {
      this.closed.push(number);
      this.writes.push(`close #${number}`);
      for (const [head, pr] of this.prs) if (pr.number === number) this.prs.delete(head);
      return Promise.resolve();
    },
  };
}

// The happy path, a step at a time. Tests drop or change the steps they're about.
const opened = (at: number, over: Partial<IssueRow> = {}): Change => ({
  at,
  apply: (w) => {
    const now = new Date(w.clock.now());
    w.issues.unshift({
      id: ISSUE,
      fingerprint: 'ph-1',
      title: TITLE,
      status: 'new',
      class: null,
      severity: null,
      currentTier: null,
      currentRunId: null,
      occurrences: 1,
      createdAt: now,
      lastSeenAt: now,
      opsFixed: false,
      ...over,
    });
  },
});
const triaged = (at: number): Change => ({
  at,
  apply: (w) =>
    Object.assign(w.issue(), { status: 'triaged', class: 'frontend', severity: 'high' }),
});
const fixing = (at: number, runId: string, tier: Tier): Change => ({
  at,
  apply: (w) => {
    Object.assign(w.issue(), { status: 'fixing', currentTier: tier, currentRunId: runId });
    w.run(runId);
  },
});
const progress = (at: number, runId: string, over: Partial<RunProgress>): Change => ({
  at,
  apply: (w) => Object.assign(w.run(runId), over),
});
const status = (at: number, value: IssueRow['status']): Change => ({
  at,
  apply: (w) => (w.issue().status = value),
});
const pr = (at: number, runId: string, number: number): Change => ({
  at,
  apply: (w) =>
    w.prs.set(`${AGENT_BRANCH_PREFIX}${runId}`, {
      number,
      url: `https://github.com/atontalapur/page-demo/pull/${number}`,
    }),
});

/** Tier 1 fixes it and the patch waits for approval. */
const tier1Fix = (): Change[] => [
  opened(40 * S),
  triaged(45 * S),
  fixing(46 * S, R1, 1),
  progress(50 * S, R1, { jobState: 'active', steps: 1 }),
  progress(6 * MIN, R1, { jobState: 'completed', steps: 14 }),
  status(6 * MIN + 2 * S, 'awaiting_approval'),
];

/** Tier 1 runs out of steps, Tier 2 fixes it but opens no PR. */
const ladderToPatch = (): Change[] => [
  opened(30 * S),
  triaged(31 * S),
  fixing(32 * S, R1, 1),
  progress(40 * S, R1, { jobState: 'active', steps: 2 }),
  progress(5 * MIN, R1, { jobState: 'completed', steps: 30 }),
  fixing(5 * MIN + 1 * S, R2, 2),
  progress(5 * MIN + 10 * S, R2, { jobState: 'active', steps: 1 }),
  progress(9 * MIN + 5 * S, R2, { jobState: 'completed', steps: 20 }),
  status(9 * MIN + 6 * S, 'awaiting_approval'),
];

/** The same climb, and Tier 2 opens a PR. */
const ladderToPr = (): Change[] => [...ladderToPatch(), pr(9 * MIN, R2, 7)];

/**
 * Tier 3 fixes the live app through the ops API and changes no code, so the orchestrator
 * resolves the issue and cancels the finished run's job before the daemon completes it.
 */
const opsFix = (): Change[] => [
  opened(10 * S),
  triaged(11 * S),
  fixing(12 * S, R3, 3),
  progress(15 * S, R3, { jobState: 'active', steps: 1 }),
  progress(4 * MIN, R3, {
    jobState: 'cancelled',
    steps: 8,
    run: {
      id: R3,
      tier: 3,
      status: 'succeeded',
      startedAt: new Date(0),
      finishedAt: new Date(0),
      prUrl: null,
    },
  }),
  {
    at: 4 * MIN,
    apply: (w) => Object.assign(w.issue(), { status: 'resolved', opsFixed: true }),
  },
];

interface Harness {
  world: World;
  clock: FakeClock;
  calls: string[];
  target: Target;
  lines: string[];
}

function harness(changes: Change[], over: Partial<Target> = {}): Harness {
  const clock = new FakeClock();
  const world = new World(clock, changes);
  const calls: string[] = [];
  const target: Target = {
    name: 'fake',
    seed: async () => {
      calls.push('seed');
      await clock.sleep(20 * S);
    },
    trigger: () => {
      calls.push('trigger');
      world.triggeredAt = clock.now();
      return Promise.resolve('500\n');
    },
    unseed: () => {
      calls.push('unseed');
      return Promise.resolve();
    },
    ...over,
  };
  return { world, clock, calls, target, lines: [] };
}

function play(h: Harness, s: Scenario, options: E2EOptions = {}, github = true) {
  return runE2E(
    s,
    {
      target: h.target,
      reader: h.world.reader,
      control: h.world.control,
      ...(github ? { github: h.world.github } : {}),
      clock: h.clock,
      log: (line) => h.lines.push(line),
    },
    options,
  );
}

const stepOf = (r: E2EResult, name: string) => r.steps.find((s) => s.step === name);
const failedChecks = (r: E2EResult) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('runE2E', () => {
  it('passes a Tier 1 fix that ends awaiting approval, timing each step', async () => {
    const h = harness(tier1Fix());
    const r = await play(h, scenario(1));

    expect(r.error).toBeNull();
    expect(r.passed).toBe(true);
    expect(r.expect).toBe('approval');
    expect(r.steps.map((s) => s.step)).toEqual([
      'seed',
      'trigger',
      'issue',
      'triage',
      'claim',
      'fix',
      'outcome',
      'assert',
      'reset',
    ]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(stepOf(r, 'seed')).toMatchObject({ offsetMs: 0, durationMs: 20 * S });
    // Polls every 3 s, so the issue that opened 40 s after the trigger is seen at 42 s.
    expect(stepOf(r, 'issue')).toMatchObject({ offsetMs: 20 * S, durationMs: 42 * S });
    expect(r.issueId).toBe(ISSUE);
    expect(r.runs).toEqual([{ runId: R1, tier: 1 }]);
    expect(r.timeToOutcomeMs).toBeGreaterThan(6 * MIN);
    expect(r.timeToOutcomeMs).toBeLessThan(6 * MIN + 10 * S);
    // Only the runs row is missing: nothing records runs yet.
    expect(failedChecks(r)).toEqual(['run.row']);
    expect(r.reset.map((a) => [a.action, a.ok, a.detail])).toEqual([
      [`kill issue ${ISSUE}`, true, 'was awaiting_approval'],
      [`find the runs of issue ${ISSUE}`, true, '1 runs'],
      [`close PR of ${R1}`, true, 'none open'],
      ['unseed', true, 'fake'],
    ]);
    expect(h.world.killed).toEqual([ISSUE]);
    expect(h.calls).toEqual(['seed', 'trigger', 'unseed']);
    expect(h.lines).toContain(`[fix] run ${R1} at tier 1`);
  });

  it('follows a ladder climb to the Tier 2 PR and closes it on reset', async () => {
    const h = harness(ladderToPr());
    const r = await play(h, scenario(2));

    expect(r.error).toBeNull();
    expect(r.passed).toBe(true);
    expect(r.expect).toBe('pr');
    expect(r.runs).toEqual([
      { runId: R1, tier: 1 },
      { runId: R2, tier: 2 },
    ]);
    expect(r.prUrl).toBe('https://github.com/atontalapur/page-demo/pull/7');
    expect(stepOf(r, 'fix')?.detail).toBe('issue awaiting_approval, tiers 1 -> 2');
    expect(failedChecks(r)).toEqual(['run.row']);
    // The kill comes first, so no run opens a PR after the close.
    expect(h.world.writes).toEqual([`kill ${ISSUE}`, 'close #7']);
  });

  it('closes the PR of a run the test never saw', async () => {
    const changes = ladderToPr();
    // A run that started and gave way between two reads, and still opened a PR.
    changes.push({ at: 5 * MIN, apply: (w) => w.run(R3) }, pr(5 * MIN, R3, 8));
    const h = harness(changes);
    const r = await play(h, scenario(2));
    expect(r.passed).toBe(true);
    expect(r.runs.map((run) => run.runId)).toEqual([R1, R2]);
    expect(h.world.writes).toEqual([`kill ${ISSUE}`, 'close #8', 'close #7']);
  });

  it('closes the PRs of the runs it saw when the run lookup fails', async () => {
    const h = harness(ladderToPr());
    h.world.reader.runIdsForIssue = () => Promise.reject(new Error('relation does not exist'));
    const r = await play(h, scenario(2));
    expect(r.failedStep).toBe('reset');
    expect(r.error).toBe(`find the runs of issue ${ISSUE}: relation does not exist`);
    expect(h.world.closed).toEqual([7]);
  });

  it('passes a Tier 2 climb that takes longer than 20 minutes', async () => {
    const changes = ladderToPr().map((c) => (c.at >= 9 * MIN ? { ...c, at: c.at + 16 * MIN } : c));
    const r = await play(harness(changes), scenario(2));
    expect(r.error).toBeNull();
    expect(r.timeToOutcomeMs).toBeGreaterThan(25 * MIN);
    expect(r.checks.find((c) => c.name === 'time.outcome')).toMatchObject({ ok: true });
    expect(r.checks.find((c) => c.name === 'time.outcome')?.detail).toContain('budget 48m00s');
  });

  it('passes a Tier 3 run waiting on a pending approval request', async () => {
    const h = harness([
      opened(10 * S),
      triaged(11 * S),
      fixing(12 * S, R1, 3),
      progress(15 * S, R1, { jobState: 'active', steps: 1 }),
      progress(2 * MIN, R1, {
        steps: 6,
        pendingApprovals: 1,
        run: {
          id: R1,
          tier: 3,
          status: 'running',
          startedAt: new Date(0),
          finishedAt: null,
          prUrl: null,
        },
      }),
    ]);
    const r = await play(h, scenario(3, 'ops'), { expect: 'approval' });

    expect(r.error).toBeNull();
    expect(r.passed).toBe(true);
    expect(stepOf(r, 'outcome')?.detail).toBe('1 pending approval');
    expect(failedChecks(r)).toEqual([]);
    // Its run waits on an approval that nothing grants after the kill, so no drain.
    expect(r.reset.map((a) => a.action)).toEqual([
      `kill issue ${ISSUE}`,
      `find the runs of issue ${ISSUE}`,
      `close PR of ${R1}`,
      'unseed',
    ]);
    expect(h.lines.some((l) => l.includes('WARNING'))).toBe(false);
  });

  describe('a Tier 3 run that asks for approval on the way to its ops fix', () => {
    /** The run asks at 2m, someone approves 10 s later, and the fix resolves the issue. */
    const askedThenFixed = (): Change[] => [
      ...opsFix().slice(0, 4),
      progress(2 * MIN, R3, { steps: 4, pendingApprovals: 1 }),
      progress(2 * MIN + 10 * S, R3, { steps: 5, pendingApprovals: 0 }),
      ...opsFix().slice(4),
    ];
    const approval: E2EApproval = {
      approvalId: '00000000-0000-4000-8000-0000000000e5',
      runId: R3,
      action: 'ops.restart',
      sentAt: '2026-11-23T12:02:00.000Z',
      decision: 'approved',
      decidedBy: 'ui:e2e',
    };

    it('lets the approver approve it, stops it before the reset, and records what it made', async () => {
      const h = harness(askedThenFixed());
      const asked: string[][] = [];
      const approver: RunApprover = {
        watch: (runId) => h.calls.push(`watch ${runId}`),
        release: () => h.calls.push('release'),
        approvals: (runIds) => {
          asked.push([...runIds]);
          return [approval];
        },
      };
      const r = await runE2E(
        scenario(3, 'ops'),
        {
          target: h.target,
          reader: h.world.reader,
          control: h.world.control,
          github: h.world.github,
          approver,
          clock: h.clock,
          log: (line) => h.lines.push(line),
        },
        { approve: 'auto' },
      );

      expect(r.error).toBeNull();
      expect(r.passed).toBe(true);
      expect(stepOf(r, 'outcome')?.detail).toBe('issue resolved by an ops fix');
      // Watched as soon as the test saw the run, released before the reset touched anything.
      expect(h.calls).toEqual(['seed', 'trigger', `watch ${R3}`, 'release', 'unseed']);
      expect(r.approve).toBe('auto');
      expect(r.approvals).toEqual([approval]);
      expect(asked).toEqual([[R3]]);
      expect(h.lines.some((l) => l.includes('is waiting for approval'))).toBe(false);
      expect(summarize(r)).toContain(`  approved ops.restart on run ${R3}: approved by ui:e2e`);
    });

    it('waits through it for a person with --approve manual, saying where to approve', async () => {
      const h = harness(askedThenFixed());
      const r = await play(h, scenario(3, 'ops'), { approve: 'manual' });

      expect(r.error).toBeNull();
      expect(r.passed).toBe(true);
      expect(r.approve).toBe('manual');
      expect(r.approvals).toEqual([]);
      const told = h.lines.filter((l) => l.includes('is waiting for approval'));
      expect(told).toEqual([
        `[fix] run ${R3} is waiting for approval: approve or reject it on the incident page ` +
          `for issue ${ISSUE}`,
      ]);
    });

    it('records no approval mode for a scenario that never reaches Tier 3', async () => {
      const r = await play(harness(tier1Fix()), scenario(1));
      expect(r.approve).toBeNull();
      expect(r.approvals).toEqual([]);
      expect(summarize(r)).not.toContain('approved ');
    });
  });

  it('passes a Tier 3 ops fix that resolved the issue on its own', async () => {
    const h = harness(opsFix());
    const r = await play(h, scenario(3, 'ops'));

    expect(r.expect).toBe('resolved');
    expect(r.error).toBeNull();
    expect(r.passed).toBe(true);
    expect(stepOf(r, 'outcome')?.detail).toBe('issue resolved by an ops fix');
    expect(r.checks.find((c) => c.name === 'issue.status')?.detail).toBe(
      'resolved by ops_fixed, want resolved by ops_fixed',
    );
    expect(failedChecks(r)).toEqual([]);
    expect(r.reset.find((a) => a.action.startsWith('kill'))?.detail).toBe('already resolved');
  });

  describe('fails at the step that ran out of time, and still resets', () => {
    const hang = (_s: Scenario, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason as Error)),
      );
    const cases: [TimedStep, () => Harness, Tier][] = [
      ['seed', () => harness(tier1Fix(), { seed: hang }), 1],
      ['trigger', () => harness(tier1Fix(), { trigger: hang }), 1],
      ['issue', () => harness([]), 1],
      ['triage', () => harness([opened(5 * S)]), 1],
      ['claim', () => harness([opened(5 * S), triaged(6 * S)]), 1],
      [
        'fix',
        () =>
          harness([
            opened(5 * S),
            triaged(6 * S),
            fixing(7 * S, R1, 1),
            progress(8 * S, R1, { jobState: 'active', steps: 3 }),
          ]),
        1,
      ],
      // Expecting a PR, but Tier 2's patch only waits for approval.
      ['outcome', () => harness(ladderToPatch()), 2],
    ];

    it.each(cases)('%s', async (name, make, tier) => {
      const h = make();
      const timeouts = { ...defaultTimeouts(scenario(tier)), [name]: 30 * S };
      const r = await play(h, scenario(tier), { timeouts });

      expect(r.passed).toBe(false);
      expect(r.failedStep).toBe(name);
      expect(r.error).toContain('timed out after 30.0s');
      const failed = stepOf(r, name)!;
      expect(failed.ok).toBe(false);
      expect(failed.durationMs).toBeGreaterThanOrEqual(30 * S);
      expect(failed.durationMs).toBeLessThan(31 * S);
      expect(h.calls.at(-1)).toBe('unseed');
      expect(stepOf(r, 'reset')?.ok).toBe(true);
      // Only a trigger that ran can have opened an issue the test didn't pick up.
      const lookedLate = r.reset.some((a) => a.action === 'look for a late issue');
      expect(lookedLate).toBe(name === 'trigger' || name === 'issue');
    });

    it('says why the issue never came', async () => {
      const h = harness([]);
      const r = await play(h, scenario(1), { timeouts: { issue: 10 * S } });
      expect(r.error).toContain('no issue opened since the trigger');
    });

    it('hints that nothing started the fix', async () => {
      const h = harness([opened(5 * S), triaged(6 * S)]);
      const r = await play(h, scenario(1), { timeouts: { claim: 10 * S } });
      expect(r.error).toContain('issue triaged at tier -, no run (nothing sent start_fix');
    });
  });

  describe('fails on a wrong end state', () => {
    it('an issue that was already open before the trigger', async () => {
      const h = harness([
        {
          at: 5 * S,
          apply: (w) => {
            const old = new Date(w.clock.now() - 10 * MIN);
            opened(0, { status: 'awaiting_approval', createdAt: old }).apply(w);
            w.issue().lastSeenAt = new Date(w.clock.now());
          },
        },
      ]);
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('issue');
      expect(r.error).toContain('was already open (awaiting_approval)');
      // The reset doesn't touch an issue the test didn't open, not even as a late one.
      expect(h.world.killed).toEqual([]);
      expect(r.reset.find((a) => a.action === 'look for a late issue')?.detail).toBe('none');
    });

    it('several new issues and none with the report title', async () => {
      const h = harness([
        opened(5 * S, { id: R1, title: 'TypeError: a' }),
        opened(6 * S, { id: R2, title: 'TypeError: b\n  more' }),
      ]);
      const r = await play(h, scenario(1), { timeouts: { issue: 20 * S } });
      expect(r.failedStep).toBe('issue');
      expect(r.error).toContain(
        `2 issues seen since the trigger, none titled "${TITLE}": "TypeError: b", "TypeError: a"`,
      );
    });

    it('waits past the only new issue when its title differs', async () => {
      const changes = tier1Fix();
      changes[0] = opened(40 * S, { title: 'Error: something else' });
      const h = harness(changes);
      const r = await play(h, scenario(1), { timeouts: { issue: 2 * MIN } });
      expect(r.failedStep).toBe('issue');
      expect(r.error).toBe(
        `timed out after 2m00s: 1 issues seen since the trigger, none titled "${TITLE}": ` +
          '"Error: something else"',
      );
      expect(stepOf(r, 'issue')!.durationMs).toBeGreaterThanOrEqual(2 * MIN);
      expect(h.world.killed).toEqual([]);
    });

    it('matches a multi-line title on its first line', async () => {
      const changes = tier1Fix();
      changes[0] = opened(40 * S, { title: `${TITLE}\n    at new NumberFormat` });
      const r = await play(harness(changes), scenario(1));
      expect(r.passed).toBe(true);
      expect(stepOf(r, 'issue')?.detail).toBe(`${ISSUE} "${TITLE}"`);
    });

    it('an issue that escalated past Tier 3', async () => {
      const h = harness([
        opened(5 * S),
        triaged(6 * S),
        fixing(7 * S, R1, 1),
        progress(8 * S, R1, { jobState: 'active', steps: 3 }),
        status(4 * MIN, 'failed'),
      ]);
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('fix');
      expect(r.error).toBe('issue ended failed at tier 1');
      expect(r.reset.find((a) => a.action.startsWith('kill'))?.detail).toBe('already failed');
    });

    it('an issue someone approved before the fix step saw it wait', async () => {
      const changes = tier1Fix();
      // awaiting_approval, then approved, between two reads.
      changes[changes.length - 1] = status(6 * MIN + 2 * S, 'resolved');
      const r = await play(harness(changes), scenario(1));
      expect(r.failedStep).toBe('fix');
      expect(r.error).toBe(
        'issue was resolved at tier 1: someone approved it before the test saw its outcome',
      );
      expect(r.reset.find((a) => a.action.startsWith('kill'))?.detail).toBe('already resolved');
    });

    it('an issue someone approved while the outcome step waited for its PR', async () => {
      const changes = [...ladderToPatch(), status(9 * MIN + 30 * S, 'resolved')];
      const r = await play(harness(changes), scenario(2));
      expect(r.failedStep).toBe('outcome');
      expect(r.error).toBe(
        'issue was resolved at tier 2: someone approved it before the test saw its outcome',
      );
    });

    it('a Tier 1 patch when a PR is expected, at once', async () => {
      const h = harness(tier1Fix());
      const r = await play(h, scenario(2));
      expect(r.expect).toBe('pr');
      expect(r.failedStep).toBe('outcome');
      expect(r.error).toBe(
        "tier 1 ended on a patch awaiting approval; Tier 1 can't push, so no PR can open",
      );
      expect(stepOf(r, 'outcome')!.durationMs).toBe(0);
    });

    it('an ops fix when an approval is expected, at once', async () => {
      const r = await play(harness(opsFix()), scenario(3, 'ops'), { expect: 'approval' });
      expect(r.failedStep).toBe('outcome');
      expect(r.error).toBe(
        'tier 3 fixed the live app through the ops API and the issue resolved; ' +
          'pass --expect resolved for it',
      );
      expect(stepOf(r, 'outcome')!.durationMs).toBe(0);
    });

    it('a Tier 3 patch when an ops fix is expected, at once', async () => {
      const h = harness([
        opened(10 * S),
        triaged(11 * S),
        fixing(12 * S, R3, 3),
        progress(15 * S, R3, { jobState: 'active', steps: 1 }),
        progress(4 * MIN, R3, { jobState: 'completed', steps: 8 }),
        status(4 * MIN, 'awaiting_approval'),
      ]);
      const r = await play(h, scenario(3, 'ops'));
      expect(r.failedStep).toBe('outcome');
      expect(r.error).toBe(
        'tier 3 left a patch for review, not a fix made live through the ops API',
      );
      expect(stepOf(r, 'outcome')!.durationMs).toBe(0);
    });

    it('a run that finished while the issue stayed fixing', async () => {
      const h = harness([
        opened(5 * S),
        triaged(6 * S),
        fixing(7 * S, R1, 1),
        progress(8 * S, R1, { jobState: 'active', steps: 3 }),
        progress(3 * MIN, R1, { jobState: 'completed', steps: 9 }),
      ]);
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('fix');
      expect(r.error).toContain('still fixing after 1m00s: its result never reached');
      expect(stepOf(r, 'fix')!.durationMs).toBeLessThan(4 * MIN);
    });

    it('a patch with no recorded steps and a failed runs row', async () => {
      const changes = tier1Fix().filter((c) => c.at < 6 * MIN);
      changes.push(
        progress(6 * MIN, R1, {
          jobState: 'completed',
          steps: 0,
          run: {
            id: R1,
            tier: 1,
            status: 'failed',
            startedAt: null,
            finishedAt: null,
            prUrl: null,
          },
        }),
        status(6 * MIN, 'awaiting_approval'),
      );
      const h = harness(changes);
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('assert');
      expect(r.error).toBe('failed: run.steps, run.row');
      expect(stepOf(r, 'reset')?.ok).toBe(true);
    });

    it('a PR the runs row disagrees with', async () => {
      const changes = ladderToPr();
      changes.push(
        progress(9 * MIN + 5 * S, R2, {
          run: {
            id: R2,
            tier: 2,
            status: 'succeeded',
            startedAt: null,
            finishedAt: null,
            prUrl: 'https://github.com/atontalapur/page-demo/pull/99',
          },
        }),
      );
      const r = await play(harness(changes), scenario(2));
      expect(r.failedStep).toBe('assert');
      expect(r.error).toBe('failed: pr.recorded');
    });

    it('an outcome past the time budget', async () => {
      const r = await play(harness(tier1Fix()), scenario(1), { budgetMs: 5 * MIN });
      expect(r.failedStep).toBe('assert');
      expect(r.checks.find((c) => c.name === 'time.outcome')?.detail).toMatch(
        /^6m0\ds from trigger, budget 5m00s$/,
      );
    });

    it('a different class and tier are warnings only', async () => {
      const changes = tier1Fix();
      changes[1] = {
        at: 45 * S,
        apply: (w) =>
          Object.assign(w.issue(), { status: 'triaged', class: 'database', severity: 'low' }),
      };
      const r = await play(harness(changes), scenario(2), { expect: 'approval' });
      expect(r.passed).toBe(true);
      expect(failedChecks(r)).toEqual(['issue.class', 'run.tier', 'run.row']);
    });
  });

  it('stops after five database reads fail in a row', async () => {
    const h = harness(tier1Fix());
    h.world.readErrors = 5;
    const r = await play(h, scenario(1));
    expect(r.failedStep).toBe('issue');
    expect(r.error).toBe('5 reads failed in a row: connection refused');
  });

  it('rides out a few failed reads', async () => {
    const h = harness(tier1Fix());
    h.world.readErrors = 2;
    const r = await play(h, scenario(1));
    expect(r.passed).toBe(true);
  });

  it('fails a passing run whose reset failed, after trying every reset part', async () => {
    const h = harness(tier1Fix());
    h.world.control.killIssue = () => Promise.reject(new Error('409 conflict'));
    const r = await play(h, scenario(1));
    expect(r.passed).toBe(false);
    expect(r.failedStep).toBe('reset');
    expect(r.error).toBe(`kill issue ${ISSUE}: 409 conflict`);
    expect(h.calls.at(-1)).toBe('unseed');
  });

  it('keeps the first failure when the reset fails too', async () => {
    const h = harness([], { unseed: () => Promise.reject(new Error('docker gone')) });
    const r = await play(h, scenario(1), { timeouts: { issue: 10 * S } });
    expect(r.failedStep).toBe('issue');
    expect(stepOf(r, 'reset')).toMatchObject({ ok: false, detail: 'unseed: docker gone' });
  });

  it('skips the reset with keep', async () => {
    const h = harness(tier1Fix());
    const r = await play(h, scenario(1), { keep: true });
    expect(r.passed).toBe(true);
    expect(r.reset).toEqual([]);
    expect(stepOf(r, 'reset')?.detail).toBe('skipped (keep)');
    expect(h.calls).toEqual(['seed', 'trigger']);
    expect(h.world.killed).toEqual([]);
  });

  it('needs GitHub to expect a PR, and touches nothing without it', async () => {
    const h = harness(ladderToPr());
    const r = await play(h, scenario(2), {}, false);
    expect(r.passed).toBe(false);
    expect(r.failedStep).toBe('seed');
    expect(r.error).toBe('expecting a PR, but no GitHub reader was given');
    expect(r.steps).toEqual([]);
    expect(r.reset).toEqual([]);
    expect(h.calls).toEqual([]);

    const approval = await play(harness(tier1Fix()), scenario(1), {}, false);
    expect(approval.passed).toBe(true);
    expect(approval.reset.map((a) => a.action)).toEqual([`kill issue ${ISSUE}`, 'unseed']);
  });

  it('refuses a report with no error line before seeding', async () => {
    const h = harness(tier1Fix());
    const s = scenario(1);
    s.meta.report = 'GET / returned 500';
    const r = await play(h, s);
    expect(r.failedStep).toBe('seed');
    expect(r.error).toBe(
      "001-bad-currency-code's report has no error line to match the issue's title against",
    );
    expect(h.calls).toEqual([]);
  });

  describe('reset drain', () => {
    // Someone kills the issue at 3 minutes, but the daemon goes on and opens its PR at 8.
    const killedMidRun = (withPr = true): Change[] => [
      opened(5 * S),
      triaged(6 * S),
      fixing(7 * S, R1, 1),
      progress(8 * S, R1, { jobState: 'active', steps: 3 }),
      status(3 * MIN, 'killed'),
      ...(withPr ? [pr(8 * MIN, R1, 9)] : []),
    ];
    const drained = (r: E2EResult) => r.reset.find((a) => a.action === `drain PRs of ${R1}`);
    const warning = (h: Harness) => h.lines.find((l) => l.startsWith('[reset] WARNING'));

    it('watches a run still in flight and closes the PR it opens after the kill', async () => {
      const h = harness(killedMidRun());
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('fix');
      expect(r.error).toBe('issue ended killed at tier 1');
      expect(r.reset.map((a) => [a.action, a.ok, a.detail])).toEqual([
        [`kill issue ${ISSUE}`, true, 'already killed'],
        [`find the runs of issue ${ISSUE}`, true, '1 runs'],
        [`close PR of ${R1}`, true, 'none open'],
        [`drain PRs of ${R1}`, true, expect.stringMatching(/^closed #9, 5m\d\ds into the drain$/)],
        ['unseed', true, 'fake'],
      ]);
      expect(h.world.closed).toEqual([9]);
      expect(warning(h)).toContain(
        `[reset] WARNING: run ${R1} still in flight. The orchestrator can't stop a run`,
      );
      expect(warning(h)).toMatch(/Watching for a PR for up to 13m\d\ds \(--drain to change\)/);
      expect(stepOf(r, 'reset')?.ok).toBe(true);
    });

    it('fails the reset when the PR is still open at the end', async () => {
      const h = harness(killedMidRun());
      h.world.github.closePullRequest = () => Promise.reject(new Error('403 forbidden'));
      const r = await play(h, scenario(1), { drainMs: 10 * MIN });
      expect(r.failedStep).toBe('fix');
      expect(stepOf(r, 'reset')).toMatchObject({
        ok: false,
        detail: `drain PRs of ${R1}: PR #9 still open after the drain: 403 forbidden`,
        durationMs: 10 * MIN,
      });
    });

    it("watches for what is left of the run's share of the fix limit, or --drain", async () => {
      const r = await play(harness(killedMidRun(false)), scenario(1));
      // Claimed seconds after the trigger and killed at 3 minutes, of 16.
      expect(drained(r)?.ok).toBe(true);
      expect(drained(r)?.detail).toMatch(/^none opened in 13m\d\ds$/);
      expect(stepOf(r, 'reset')!.durationMs).toBeGreaterThan(13 * MIN);

      const short = await play(harness(killedMidRun(false)), scenario(1), { drainMs: 2 * MIN });
      expect(drained(short)?.detail).toBe('none opened in 2m00s');
    });

    it('only warns with --drain 0, or without GitHub', async () => {
      const h = harness(killedMidRun());
      const r = await play(h, scenario(1), { drainMs: 0 });
      expect(drained(r)).toBeUndefined();
      expect(stepOf(r, 'reset')).toMatchObject({ ok: true, durationMs: 0 });
      expect(warning(h)).toContain('Not watching for a PR: --drain 0');

      const bare = harness(killedMidRun());
      const unwatched = await play(bare, scenario(1), {}, false);
      expect(drained(unwatched)).toBeUndefined();
      expect(warning(bare)).toContain('With no GitHub reader, the reset cannot close');
    });

    it('goes on the last read when the database fails at the reset', async () => {
      const h = harness(killedMidRun());
      const failed = () => h.lines.some((l) => l.startsWith('[fix] FAILED'));
      const real = { ...h.world.reader };
      h.world.reader.issue = (id) =>
        failed() ? Promise.reject(new Error('connection refused')) : real.issue(id);
      h.world.reader.run = (id) =>
        failed() ? Promise.reject(new Error('connection refused')) : real.run(id);
      const r = await play(h, scenario(1));
      expect(r.reset.find((a) => a.action.startsWith('kill'))).toMatchObject({
        ok: false,
        detail: 'connection refused',
      });
      expect(drained(r)?.detail).toMatch(/^closed #9/);
    });
  });

  describe('a late issue', () => {
    it('is killed and its PRs closed when it opened after the issue step gave up', async () => {
      const h = harness([
        opened(20 * S),
        triaged(21 * S),
        fixing(22 * S, R1, 1),
        progress(23 * S, R1, { jobState: 'active', steps: 1 }),
        pr(24 * S, R1, 9),
      ]);
      // The issue step never sees it, as if it opened just after the step gave up.
      const real = { ...h.world.reader };
      h.world.reader.issuesSeenSince = (since) =>
        h.lines.some((l) => l.startsWith('[issue] FAILED'))
          ? real.issuesSeenSince(since)
          : Promise.resolve([]);
      const r = await play(h, scenario(1), { timeouts: { issue: 30 * S }, drainMs: MIN });

      expect(r.failedStep).toBe('issue');
      expect(r.issueId).toBeNull();
      expect(r.reset.map((a) => [a.action, a.ok, a.detail])).toEqual([
        ['look for a late issue', true, `${ISSUE} fixing, opened 2026-11-15T00:00:50.000Z`],
        [`kill issue ${ISSUE}`, true, 'was fixing'],
        [`find the runs of issue ${ISSUE}`, true, '1 runs'],
        [`close PR of ${R1}`, true, 'closed #9'],
        // Its run was claimed, so the drain watches it too.
        [`drain PRs of ${R1}`, true, 'none opened in 1m00s'],
        ['unseed', true, 'fake'],
      ]);
      expect(h.world.writes).toEqual([`kill ${ISSUE}`, 'close #9']);
    });

    it('is not looked for when the trigger never ran', async () => {
      const h = harness([], { seed: () => Promise.reject(new Error('no docker')) });
      const r = await play(h, scenario(1));
      expect(r.reset.map((a) => a.action)).toEqual(['unseed']);
    });
  });

  it('fails a trigger script that exits non-zero', async () => {
    const h = harness([], { trigger: () => Promise.reject(new Error('trigger.sh exited 7')) });
    const r = await play(h, scenario(1));
    expect(r.failedStep).toBe('trigger');
    expect(r.error).toBe('trigger.sh exited 7');
  });

  describe("the target's logs after a failed seed", () => {
    const logs = (text: string | null) => (calls: string[]) => () => {
      calls.push('logs');
      return Promise.resolve(text);
    };

    it('are read before the reset unseeds, and summarized', async () => {
      const h = harness([], {
        seed: () => Promise.reject(new Error('container page-e2e-demo-app exited with code 1')),
      });
      h.target.logs = logs('migrating\nError: relation "products" does not exist')(h.calls);
      const r = await play(h, scenario(1));
      expect(r.failedStep).toBe('seed');
      expect(r.error).toBe('container page-e2e-demo-app exited with code 1');
      expect(r.seedLogs).toBe('migrating\nError: relation "products" does not exist');
      expect(h.calls).toEqual(['logs', 'unseed']);
      expect(summarize(r)).toContain(
        '  fake logs:\n    migrating\n    Error: relation "products" does not exist',
      );
    });

    it('are read when the seed runs out of time too', async () => {
      const h = harness([], {
        seed: (_s, signal) =>
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason as Error)),
          ),
      });
      h.target.logs = logs('compiling...')(h.calls);
      const r = await play(h, scenario(1), { timeouts: { seed: MIN } });
      expect(r.error).toBe('timed out after 1m00s');
      expect(r.seedLogs).toBe('compiling...');
      expect(h.calls).toEqual(['logs', 'unseed']);
    });

    it("note logs that couldn't be read, and aren't asked for after a good seed", async () => {
      const h = harness([], { seed: () => Promise.reject(new Error('no image')) });
      h.target.logs = () => Promise.reject(new Error('docker gone'));
      const r = await play(h, scenario(1));
      expect(r.seedLogs).toBe('(could not read them: docker gone)');

      const good = harness(tier1Fix());
      good.target.logs = logs('unused')(good.calls);
      const passed = await play(good, scenario(1));
      expect(passed.seedLogs).toBeNull();
      expect(good.calls).not.toContain('logs');
    });
  });
});

describe('prepareTarget', () => {
  const target = (prepare?: Target['prepare']): Target => ({
    name: 'fake',
    seed: () => Promise.resolve(),
    trigger: () => Promise.resolve(''),
    unseed: () => Promise.resolve(),
    ...(prepare === undefined ? {} : { prepare }),
  });

  it('times the preparation once, apart from any step', async () => {
    const clock = new FakeClock();
    const lines: string[] = [];
    const built = await prepareTarget(
      scenario(1),
      target(async (s) => {
        await clock.sleep(3 * MIN);
        return `built for ${s.id}`;
      }),
      { clock, timeoutMs: 20 * MIN, log: (line) => lines.push(line) },
    );
    expect(built).toEqual({
      ok: true,
      durationMs: 3 * MIN,
      detail: 'built for 001-bad-currency-code',
    });
    expect(lines).toEqual([
      '[prepare] ...',
      '[prepare] ok in 3m00s: built for 001-bad-currency-code',
    ]);
  });

  it('is null with nothing to prepare', async () => {
    const clock = new FakeClock();
    expect(await prepareTarget(scenario(1), target(), { clock, timeoutMs: MIN })).toBeNull();
    const nothing = target(() => Promise.resolve(null));
    expect(await prepareTarget(scenario(1), nothing, { clock, timeoutMs: MIN })).toBeNull();
  });

  it('records a failure or a timeout', async () => {
    const clock = new FakeClock();
    const failing = target(() => Promise.reject(new Error('build page-sandbox exited 1')));
    expect(await prepareTarget(scenario(1), failing, { clock, timeoutMs: MIN })).toEqual({
      ok: false,
      durationMs: 0,
      detail: 'build page-sandbox exited 1',
    });
    const hanging = target(
      (_s, signal) =>
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason as Error)),
        ),
    );
    expect(await prepareTarget(scenario(1), hanging, { clock, timeoutMs: MIN })).toEqual({
      ok: false,
      durationMs: MIN,
      detail: 'timed out after 1m00s',
    });
  });
});

describe('waitHealthy', () => {
  const answers = (...codes: (number | Error)[]) => {
    const seen: string[] = [];
    const fake: typeof fetch = (input) => {
      seen.push(typeof input === 'string' ? input : 'not a string');
      const next = codes.shift() ?? 200;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(new Response(null, { status: next }));
    };
    return { seen, fetch: fake };
  };

  it('polls /api/health until it answers 200', async () => {
    const clock = new FakeClock();
    const { seen, fetch } = answers(new Error('ECONNREFUSED'), 503, 200);
    const began = clock.now();
    await waitHealthy('http://localhost:3100', new AbortController().signal, { clock, fetch });
    expect(seen).toEqual(Array(3).fill('http://localhost:3100/api/health'));
    expect(clock.now() - began).toBe(4 * S);
  });

  it('fails at once when the app is gone', async () => {
    const clock = new FakeClock();
    const { seen, fetch } = answers(new Error('ECONNREFUSED'), new Error('ECONNREFUSED'));
    let checks = 0;
    const gone = () => {
      checks += 1;
      return Promise.resolve(checks < 2 ? null : 'container x exited with code 1');
    };
    await expect(
      waitHealthy('http://localhost:3100', new AbortController().signal, { clock, fetch, gone }),
    ).rejects.toThrow('container x exited with code 1');
    expect(seen).toHaveLength(2);
  });

  it('stops when its signal aborts', async () => {
    const clock = new FakeClock();
    const stop = new AbortController();
    const { fetch } = answers(...Array<number>(10).fill(503));
    const waiting = waitHealthy('http://localhost:3100', stop.signal, { clock, fetch });
    stop.abort(new Error('timed out'));
    await expect(waiting).rejects.toThrow('timed out');
  });
});

describe('containerStopped', () => {
  it('reads docker inspect', () => {
    expect(containerStopped('app', { code: 0, output: 'running 0\n' })).toBeNull();
    expect(containerStopped('app', { code: 0, output: 'created 0' })).toBeNull();
    expect(containerStopped('app', { code: 0, output: 'exited 1\n' })).toBe(
      'container app exited with code 1 before /api/health answered',
    );
    expect(containerStopped('app', { code: 0, output: 'dead 137' })).toBe(
      'container app dead with code 137 before /api/health answered',
    );
    expect(containerStopped('app', { code: 1, output: 'Error: No such object: app\n' })).toBe(
      'container app is gone: Error: No such object: app',
    );
  });
});

describe('localAppUrl', () => {
  it('defaults to the compose app on DEMO_APP_PORT', () => {
    expect(localAppUrl({})).toBe('http://localhost:3000');
    expect(localAppUrl({ DEMO_APP_PORT: '3200' })).toBe('http://localhost:3200');
    expect(() => localAppUrl({ DEMO_APP_PORT: 'web' })).toThrow(
      'DEMO_APP_PORT must be a port number, not web',
    );
  });

  it('takes E2E_LOCAL_APP_URL on this machine, and never DEMO_APP_URL', () => {
    const staging = 'https://demo-app-staging.up.railway.app';
    expect(localAppUrl({ DEMO_APP_URL: staging })).toBe('http://localhost:3000');
    expect(localAppUrl({ E2E_LOCAL_APP_URL: 'http://127.0.0.1:3000/' })).toBe(
      'http://127.0.0.1:3000',
    );
    expect(localAppUrl({ E2E_LOCAL_APP_URL: 'http://[::1]:3000' })).toBe('http://[::1]:3000');
    expect(localAppUrl({ E2E_LOCAL_APP_URL: 'http://LOCALHOST:3000' })).toBe(
      'http://LOCALHOST:3000',
    );
  });

  it('refuses a host off this machine, or no URL at all', () => {
    expect(() => localAppUrl({ E2E_LOCAL_APP_URL: 'https://demo.example.com' })).toThrow(
      'E2E_LOCAL_APP_URL must be on this machine (localhost, 127.0.0.1 or ::1), not ' +
        'demo.example.com',
    );
    expect(() => localAppUrl({ E2E_LOCAL_APP_URL: 'http://10.0.0.5:3000' })).toThrow(
      'not 10.0.0.5',
    );
    expect(() => localAppUrl({ E2E_LOCAL_APP_URL: 'localhost:3000' })).toThrow(
      'E2E_LOCAL_APP_URL must be an http(s) URL, not localhost:3000',
    );
    expect(() => localAppUrl({ E2E_LOCAL_APP_URL: '::' })).toThrow(
      'E2E_LOCAL_APP_URL is not a URL: ::',
    );
  });
});

describe('helpers', () => {
  it('picks the error line of a report', () => {
    expect(reportErrorLine(scenario().meta.report)).toBe(TITLE);
    expect(reportErrorLine('one line')).toBeNull();
    expect(reportErrorLine('GET /\n\n')).toBeNull();
  });

  it("matches an issue's title on its first line", () => {
    expect(issueTitleMatches(TITLE, TITLE)).toBe(true);
    expect(issueTitleMatches(`  ${TITLE}  `, TITLE)).toBe(true);
    expect(issueTitleMatches('ZodError: [\n  {\n    "code": "invalid_type"', 'ZodError: [')).toBe(
      true,
    );
    expect(issueTitleMatches('ZodError: [ ]', 'ZodError: [')).toBe(false);
    expect(issueTitleMatches('Exception', TITLE)).toBe(false);
  });

  it('formats durations', () => {
    expect(formatMs(4200)).toBe('4.2s');
    expect(formatMs(125_000)).toBe('2m05s');
  });

  it('expects a PR from a Tier 2 code scenario and a resolved issue from an ops one', () => {
    expect(defaultExpectation(scenario(1))).toBe('approval');
    expect(defaultExpectation(scenario(2))).toBe('pr');
    expect(defaultExpectation(scenario(3, 'ops'))).toBe('resolved');
  });

  it('gives the fix 16 minutes per tier up to the expected one', () => {
    expect(defaultTimeouts(scenario(1)).fix).toBe(16 * MIN);
    expect(defaultTimeouts(scenario(2)).fix).toBe(32 * MIN);
    expect(stepTimeouts(scenario(2), { seed: MIN })).toEqual({
      ...defaultTimeouts(scenario(2)),
      seed: MIN,
    });
  });

  it('budgets the sum of the step limits from the trigger to the outcome', () => {
    expect(defaultBudget(defaultTimeouts(scenario(1)))).toBe(32 * MIN);
    expect(defaultBudget(defaultTimeouts(scenario(2)))).toBe(48 * MIN);
    expect(defaultBudget(defaultTimeouts(scenario(3)))).toBe(64 * MIN);
    // Seed and reset fall outside it.
    expect(defaultBudget({ ...defaultTimeouts(scenario(1)), seed: 1, reset: 1, fix: MIN })).toBe(
      17 * MIN,
    );
  });

  it('parses durations and --timeout values', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('90s')).toBe(90 * S);
    expect(parseDuration('1.5h')).toBe(90 * MIN);
    expect(() => parseDuration('20')).toThrow('is not a duration');
    expect(() => parseDuration('0s')).toThrow('longer than 0');
    expect(parseTimeouts(['fix=20m', 'issue=90s'])).toEqual({ fix: 20 * MIN, issue: 90 * S });
    expect(() => parseTimeouts(['assert=1m'])).toThrow('want <step>=<duration>');
    expect(() => parseTimeouts(['fix'])).toThrow('want <step>=<duration>');
    expect(() => parseTimeouts(['fix=1m=2'])).toThrow('want <step>=<duration>');
  });

  it('parses --drain, where 0 skips the watch', () => {
    expect(parseDrain('0')).toBe(0);
    expect(parseDrain('0s')).toBe(0);
    expect(parseDrain('5m')).toBe(5 * MIN);
    expect(() => parseDrain('soon')).toThrow('is not a duration');
  });

  it('summarizes a result', async () => {
    const changes = tier1Fix();
    changes[1] = {
      at: 45 * S,
      apply: (w) =>
        Object.assign(w.issue(), { status: 'triaged', class: 'database', severity: 'low' }),
    };
    const h = harness(changes);
    h.world.control.killIssue = () => Promise.reject(new Error('409'));
    const text = summarize(await play(h, scenario(1)));
    expect(text.split('\n')[0]).toBe(
      `FAIL 001-bad-currency-code on fake (expect approval): reset kill issue ${ISSUE}: 409`,
    );
    expect(text).toContain('  ok   seed       20.0s  001-bad-currency-code on fake');
    expect(text).toContain('  FAIL reset ');
    expect(text).toMatch(/trigger to outcome: 6m0\ds/);
    expect(text).toContain('  warn issue.class: database, scenario says frontend');
    expect(text).toContain(`  reset kill issue ${ISSUE} failed: 409`);

    const passed = summarize(await play(harness(tier1Fix()), scenario(1)));
    expect(passed.split('\n')[0]).toBe('PASS 001-bad-currency-code on fake (expect approval)');
  });
});

// The issue the orchestrator opens for each dev scenario has to match the scenario's report.
describe('dev scenario titles', () => {
  const ROOT = join(import.meta.dirname, '..', '..');

  /**
   * ingest.service.ts titleFrom: PostHog's exception type and value (posthog-node sends
   * the error's `name` and `message`) joined by ': ', trimmed and cut at 500 characters.
   */
  const titleFrom = (type: string, value: string) =>
    [type, value]
      .filter((part) => part.trim().length > 0)
      .join(': ')
      .trim()
      .slice(0, 500);

  it("titles each dev scenario's issue so its first line is the report's error line", async () => {
    const split = await loadSplit(join(ROOT, 'eval', 'split.json'));
    const mismatched: string[] = [];
    for (const id of split.dev) {
      const { meta } = await loadScenario(join(ROOT, 'scenarios', id));
      const line = reportErrorLine(meta.report);
      if (line === null) {
        mismatched.push(`${id}: no error line`);
        continue;
      }
      // The report prints the error the way Node does: `<name>: <message>`, the message
      // over as many lines as it has, then the stack.
      const error = meta.report.slice(meta.report.indexOf(line)).split(/\n {4}at /)[0]!;
      const colon = error.indexOf(': ');
      const title =
        colon === -1
          ? titleFrom(error, '')
          : titleFrom(error.slice(0, colon), error.slice(colon + 2));
      if (!issueTitleMatches(title, line)) mismatched.push(`${id}: ${JSON.stringify(title)}`);
    }
    expect(mismatched).toEqual([]);
  });
});
