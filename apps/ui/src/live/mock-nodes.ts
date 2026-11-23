import type {
  EscalationNote,
  Issue,
  IssueRun,
  NodeRun,
  NodeSummary,
  Run,
  Step,
  Tier,
} from '@page/contracts';

import type { RunEventName } from './source';

/** The daemons the mock plays: two connected, one known only from the runs it worked. */
export const MOCK_NODES = ['mock-node-1', 'mock-node-2', 'mock-node-3'] as const;

// The daemon that drops off and comes back, every this many ticks, once it holds no run.
const FLAKY = 'mock-node-2';
const FLAKY_EVERY = 10;

type StepSeed = Pick<Step, 'kind' | 'input' | 'outputTrimmed' | 'exitCode' | 'thought'>;

const CART = 'apps/demo-app/src/shop/cart.ts';
const TEST = 'pnpm --filter @page/demo-app exec vitest run src/shop/cart.test.ts';

// A run's steps, in the agent's order, played again from the top for a long run.
const STEPS: StepSeed[] = [
  {
    kind: 'exec',
    input: `cat -n ${CART}`,
    outputTrimmed: '12  return items.slice(0, -1).reduce(sum, 0);',
    exitCode: 0,
    thought: 'Find where the cart total is summed.',
  },
  {
    kind: 'exec',
    input: TEST,
    outputTrimmed: 'Tests  1 failed | 4 passed (5)',
    exitCode: 1,
    thought: 'Reproduce the failure before changing anything.',
  },
  {
    kind: 'edit',
    input: JSON.stringify({
      path: CART,
      oldText: 'items.slice(0, -1).reduce(sum, 0)',
      newText: 'items.reduce(sum, 0)',
    }),
    outputTrimmed: '',
    exitCode: 0,
    thought: 'The slice drops the last line item. Sum every item.',
  },
  { kind: 'exec', input: TEST, outputTrimmed: 'Tests  5 passed (5)', exitCode: 0, thought: null },
  {
    kind: 'exec',
    input: 'pnpm --filter @page/demo-app lint',
    outputTrimmed: '',
    exitCode: 0,
    thought: null,
  },
];

const DIFF = [
  `--- a/${CART}`,
  `+++ b/${CART}`,
  '@@ -11,3 +11,3 @@',
  ' export function total(items: Item[]) {',
  '-  return items.slice(0, -1).reduce(sum, 0);',
  '+  return items.reduce(sum, 0);',
  ' }',
  '',
].join('\n');

const NOTE: EscalationNote = {
  summary: 'The total is short by one item, but the tests still fail after the change.',
  tried: ['Read src/shop/cart.ts', 'Ran the cart tests: 1 failing'],
  blocker: 'A second caller trims the list too, outside what Tier 1 may edit.',
};

/** A valid v4 uuid per number, apart from the issues' (mockId). */
function runId(n: number): string {
  const head = (Math.imul(n + 7_919, 0x85ebca6b) >>> 0).toString(16).padStart(8, '0');
  return `${head}-9a1b-4c2d-9e3f-${n.toString(16).padStart(12, '0')}`;
}

interface MockRun {
  run: IssueRun;
  issueTitle: string;
  node: string;
  /** When the daemon took it, for lastRunAt and the newest-first order. */
  takenAt: string;
}

/** What the mock daemons tell the store, each event parsed like one from the server. */
export interface NodeOutlet {
  run(event: RunEventName, payload: unknown): void;
  node(payload: unknown): void;
}

const live = (run: Pick<Run, 'status'>) => run.status === 'queued' || run.status === 'running';

function rowOf(run: IssueRun): Run {
  const { id, issueId, tier, status, startedAt, finishedAt, prUrl, confidence } = run;
  return { id, issueId, tier, status, startedAt, finishedAt, prUrl, confidence };
}

/**
 * The mock's node daemons and their runs. A run starts when an issue moves to fixing, a new
 * one when it escalates, and each running run writes a step per tick. The run ends as
 * escalated, succeeded or killed when its issue moves on.
 */
export function mockNodes(now: () => Date) {
  const runs: MockRun[] = [];
  const nodes = new Map<string, { connected: boolean; since: string | null }>([
    [MOCK_NODES[0], { connected: true, since: null }],
    [MOCK_NODES[1], { connected: true, since: null }],
    [MOCK_NODES[2], { connected: false, since: null }],
  ]);
  let count = 0;
  let ticks = 0;
  // The flaky daemon's turn to drop or return has come, and waits until it holds no run.
  let flakyDue = false;
  let out: NodeOutlet | undefined;

  const at = (minutesAgo = 0) => new Date(now().getTime() - minutesAgo * 60_000).toISOString();

  function summary(name: string): NodeSummary {
    const state = nodes.get(name) ?? { connected: false, since: null };
    const own = runs.filter((r) => r.node === name);
    const taken = own.map((r) => r.takenAt).sort();
    return {
      name,
      connected: state.connected,
      since: state.since,
      current: own.filter((r) => live(r.run)).map(nodeRun),
      lastRunAt: taken.at(-1) ?? null,
    };
  }

  function nodeRun({ run, issueTitle }: MockRun): NodeRun {
    return {
      ...rowOf(run),
      issueTitle,
      stepCount: run.steps.length,
      lastStep: run.steps.at(-1) ?? null,
    };
  }

  function addStep(entry: MockRun, minutesAgo = 0): Step {
    const seq = entry.run.steps.length;
    const step: Step = {
      ...STEPS[seq % STEPS.length]!,
      runId: entry.run.id,
      seq,
      allowed: true,
      createdAt: at(minutesAgo),
    };
    entry.run.steps.push(step);
    return step;
  }

  /** A connected daemon with no run, else any connected one, else the first, brought back. */
  function pick(): string {
    const connected = [...nodes].filter(([, state]) => state.connected).map(([name]) => name);
    const idle = connected.find((name) => !runs.some((r) => r.node === name && live(r.run)));
    const name = idle ?? connected[0] ?? MOCK_NODES[0];
    const state = nodes.get(name)!;
    if (!state.connected) nodes.set(name, { connected: true, since: at() });
    return name;
  }

  function begin(issue: Issue, tier: Tier): void {
    count += 1;
    const entry: MockRun = {
      run: {
        id: runId(count),
        issueId: issue.id,
        tier,
        status: 'running',
        startedAt: at(),
        finishedAt: null,
        prUrl: null,
        confidence: null,
        diff: null,
        steps: [],
        chats: [],
      },
      issueTitle: issue.title,
      node: pick(),
      takenAt: at(),
    };
    runs.push(entry);
    out?.run('run.started', { v: 1, run: rowOf(entry.run) });
    out?.run('run.step', { v: 1, step: addStep(entry) });
    out?.node({ v: 1, node: summary(entry.node) });
  }

  function finish(issueId: string, status: 'succeeded' | 'escalated' | 'killed'): void {
    const entry = runs.find((r) => r.run.issueId === issueId && live(r.run));
    if (!entry) return;
    if (status === 'succeeded') {
      entry.run.diff = DIFF;
      out?.run('run.diff', { v: 1, runId: entry.run.id, diff: DIFF });
    }
    entry.run.status = status;
    entry.run.finishedAt = at();
    out?.run('run.finished', {
      v: 1,
      run: rowOf(entry.run),
      note: status === 'escalated' ? NOTE : null,
    });
    out?.node({ v: 1, node: summary(entry.node) });
  }

  /** A finished run for a seed issue, `minutesAgo` back, with every scripted step. */
  function past(issue: Issue, tier: Tier, node: string, status: Run['status'], minutesAgo: number) {
    count += 1;
    const entry: MockRun = {
      run: {
        id: runId(count),
        issueId: issue.id,
        tier,
        status,
        startedAt: at(minutesAgo),
        finishedAt: live({ status }) ? null : at(minutesAgo - 3),
        prUrl: null,
        confidence: null,
        diff: status === 'succeeded' ? DIFF : null,
        steps: [],
        chats: [],
      },
      issueTitle: issue.title,
      node,
      takenAt: at(minutesAgo),
    };
    runs.push(entry);
    const steps = live({ status }) ? 2 : STEPS.length;
    for (let i = 0; i < steps; i++) addStep(entry, minutesAgo - i * 0.5);
  }

  return {
    /** Runs for the seeded issues, so every page has history from the start. */
    seed(issues: readonly Issue[]): void {
      for (const issue of issues) {
        if (issue.status === 'fixing') past(issue, 1, MOCK_NODES[0], 'running', 2);
        if (issue.status === 'awaiting_approval') {
          past(issue, 1, MOCK_NODES[2], 'escalated', 40);
          past(issue, 2, MOCK_NODES[1], 'succeeded', 30);
        }
        if (issue.status === 'resolved') past(issue, 1, MOCK_NODES[2], 'succeeded', 70);
      }
    },

    start(outlet: NodeOutlet): NodeSummary[] {
      out = outlet;
      return MOCK_NODES.map(summary);
    },

    stop(): void {
      out = undefined;
    },

    /** What a change to an issue does to its runs. */
    follow(before: Issue | undefined, after: Issue): void {
      const wasFixing = before?.status === 'fixing';
      if (after.status === 'fixing' && after.currentTier !== null) {
        if (!wasFixing) return begin(after, after.currentTier);
        if (before.currentTier !== after.currentTier) {
          finish(after.id, 'escalated');
          begin(after, after.currentTier);
        }
        return;
      }
      if (!wasFixing) return;
      finish(after.id, after.status === 'killed' ? 'killed' : 'succeeded');
    },

    /** One step for every running run, and now and then the flaky daemon drops or returns. */
    tick(): void {
      ticks += 1;
      for (const entry of runs.filter((r) => r.run.status === 'running')) {
        out?.run('run.step', { v: 1, step: addStep(entry) });
      }
      flakyDue ||= ticks % FLAKY_EVERY === 0;
      const busy = runs.some((r) => r.node === FLAKY && live(r.run));
      if (flakyDue && !busy) {
        flakyDue = false;
        const state = nodes.get(FLAKY)!;
        nodes.set(FLAKY, { connected: !state.connected, since: at() });
        out?.node({ v: 1, node: summary(FLAKY) });
      }
    },

    /** An issue's runs, oldest first, as GET /issues/:id/runs gives them. */
    runsOf(issueId: string): IssueRun[] {
      return runs
        .filter((r) => r.run.issueId === issueId)
        .map((r) => structuredClone(r.run))
        .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
    },

    /** A daemon's runs, newest first, as GET /nodes/:name/runs gives them. */
    runsBy(name: string): NodeRun[] {
      return runs
        .filter((r) => r.node === name)
        .sort((a, b) => b.takenAt.localeCompare(a.takenAt))
        .map(nodeRun);
    },
  };
}
