// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { IssueRun, Run, Step } from '@page/contracts';

import { runFixture } from '@page/contracts/fixtures';

import IncidentDetailsPage from './IncidentDetailsPage';

// jsdom can't run the highlighter; these stand in for its views.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: ({ patch }: { patch: string }) => <pre data-testid="patch-diff">{patch}</pre>,
  MultiFileDiff: ({
    oldFile,
    newFile,
  }: {
    oldFile: { contents: string };
    newFile: { contents: string };
  }) => <pre data-testid="edit-diff">{`${oldFile.contents} -> ${newFile.contents}`}</pre>,
}));
import { issue, renderWithIssues, testSource, type TestSource } from '../test-utils';

afterEach(() => {
  cleanup();
});

const fixing = issue(1, {
  title: 'Database connection timeout',
  status: 'fixing',
  class: 'database',
  severity: 'critical',
  occurrences: 24,
  currentTier: 2,
});
const fresh = issue(2, { status: 'new', class: null, severity: null, currentTier: null });

function run(
  tier: 1 | 2 | 3,
  status: IssueRun['status'],
  fields: Partial<IssueRun> = {},
): IssueRun {
  return {
    id: `${tier}0000000-2222-4222-8222-222222222222`,
    issueId: fixing.id,
    tier,
    status,
    startedAt: '2026-11-22T09:00:00.000Z',
    finishedAt: null,
    prUrl: null,
    confidence: null,
    diff: null,
    steps: [],
    chats: [],
    ...fields,
  };
}

function step(seq: number, input: string, fields: Partial<Step> = {}): Step {
  return {
    runId: '10000000-2222-4222-8222-222222222222',
    seq,
    kind: 'exec',
    input,
    outputTrimmed: '',
    exitCode: 0,
    allowed: true,
    thought: null,
    createdAt: '2026-11-22T09:00:00.000Z',
    ...fields,
  };
}

function renderDetails(id: string, source: TestSource = testSource([fixing, fresh])) {
  renderWithIssues(<IncidentDetailsPage />, source, {
    path: `/incidents/${id}`,
    route: '/incidents/:id',
  });
  return source;
}

function metric(label: string) {
  const title = screen.getByText(label, { selector: '[data-slot="card-title"]' });
  return within(title.closest('[data-slot="card"]') as HTMLElement);
}

describe('IncidentDetailsPage', () => {
  it("shows the issue's fields", () => {
    renderDetails(fixing.id);

    expect(screen.getByRole('heading', { name: fixing.title })).toBeTruthy();
    expect(screen.getByText(fixing.id.slice(0, 8))).toBeTruthy();
    expect(metric('Occurrences').getByText('24')).toBeTruthy();
    expect(metric('Class').getByText('Database')).toBeTruthy();
    expect(metric('Current Tier').getByText('Tier 2')).toBeTruthy();
    expect(
      metric('Last Updated').getByText(new Date(fixing.updatedAt).toLocaleString()),
    ).toBeTruthy();
    expect(screen.getByText(fixing.id)).toBeTruthy();
    expect(screen.getByText(fixing.fingerprint)).toBeTruthy();

    const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));
    expect(badges.map((badge) => badge.textContent)).toEqual(['Critical', 'Fixing']);
    for (const badge of badges) expect(badge.className).toMatch(/bg-\w+-a3 text-\w+-11/);
  });

  it('shows an untriaged issue as such', () => {
    renderDetails(fresh.id);

    expect(metric('Class').getByText('Untriaged')).toBeTruthy();
    expect(metric('Current Tier').getByText('None')).toBeTruthy();
    expect(screen.getByText('Untriaged', { selector: '[data-slot="badge"]' })).toBeTruthy();
  });

  it('shows the latest run: figures, the patch, and its steps by phase with their results', async () => {
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [
      run(1, 'escalated', {
        steps: [step(0, 'pnpm --filter @page/demo-app test', { exitCode: 1 })],
      }),
      run(2, 'succeeded', {
        startedAt: '2026-11-22T09:00:00.000Z',
        finishedAt: '2026-11-22T09:02:27.000Z',
        prUrl: 'https://github.com/o/page-demo/pull/7',
        diff: 'diff --git a/apps/demo-app/src/shop/products.ts b/apps/demo-app/src/shop/products.ts\n--- a/apps/demo-app/src/shop/products.ts\n+++ b/apps/demo-app/src/shop/products.ts\n@@ -1 +1 @@\n-old\n+new',
        steps: [
          step(0, 'cat -n apps/demo-app/src/shop/products.ts'),
          step(1, 'cat x/[slug]', {
            allowed: false,
            exitCode: null,
            outputTrimmed: 'refused: unquoted glob characters are not allowed',
          }),
          step(2, 'pnpm --filter @page/demo-app exec vitest run src/shop/products.test.ts', {
            exitCode: 1,
            outputTrimmed:
              'error: operator does not exist: text = integer\n Tests  1 failed | 1 passed (2)',
          }),
          step(
            3,
            JSON.stringify({
              path: 'apps/demo-app/src/shop/products.ts',
              oldText: 'old',
              newText: 'new',
            }),
            {
              kind: 'edit',
            },
          ),
          step(4, 'pnpm --filter @page/demo-app test', {
            outputTrimmed: ' Tests  124 passed (124)',
          }),
        ],
      }),
    ]);
    renderDetails(fixing.id, source);

    const tier2 = await screen.findAllByRole('list', { name: 'Tier 2 steps' });
    const steps = within(tier2[0]!.closest('section')!.parentElement!);
    expect(steps.getByText(/^Read /)).toBeTruthy();
    expect(steps.getByText('Refused')).toBeTruthy();
    expect(steps.getByText('Policy: unquoted glob characters are not allowed')).toBeTruthy();
    expect(steps.getByText('Exit 1')).toBeTruthy();
    expect(steps.getByText('Tests 1 failed | 1 passed (2)', { selector: 'p' })).toBeTruthy();
    expect(
      steps.getByText('error: operator does not exist: text = integer', { selector: 'p' }),
    ).toBeTruthy();
    expect(steps.getByText('Tests 124 passed (124)', { selector: 'p' })).toBeTruthy();
    expect(
      screen
        .getAllByRole('region')
        .map((r) => r.getAttribute('aria-label'))
        .filter(Boolean),
    ).toEqual(
      expect.arrayContaining([
        'Explore, from step 0',
        'Reproduce, from step 2',
        'Fix, from step 3',
        'Verify, from step 4',
      ]),
    );

    // The patch and the edit render through @pierre/diffs (mocked here).
    expect((await screen.findByTestId('patch-diff')).textContent).toContain('+new');
    expect((await screen.findByTestId('edit-diff')).textContent).toBe('old -> new');
    expect(screen.getByText('2m 27s')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the pull request' }).getAttribute('href')).toBe(
      'https://github.com/o/page-demo/pull/7',
    );
    // The earlier run is there, collapsed.
    expect(screen.getByText('Earlier runs')).toBeTruthy();
  });

  it("leads each step with the agent's reasoning, and cuts a long one short until asked", async () => {
    const long = `Read the query first. ${'The id column is an integer. '.repeat(20)}`;
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [
      run(1, 'running', {
        steps: [
          step(0, 'cat -n src/shop/products.ts', { thought: 'Find the `getProduct` lookup.' }),
          step(1, 'pnpm test', { thought: long }),
          step(2, 'ls'),
        ],
      }),
    ]);
    renderDetails(fixing.id, source);

    expect((await screen.findByText('getProduct')).tagName).toBe('CODE');
    const more = screen.getByRole('button', { name: 'Show all of it' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it("shows the running run's last step as running until it has an outcome", async () => {
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [
      run(1, 'escalated', {
        steps: [step(0, 'pnpm test', { exitCode: null, outputTrimmed: 'killed' })],
      }),
      run(2, 'running', {
        steps: [step(0, 'ls'), step(1, 'pnpm test', { exitCode: null, outputTrimmed: '' })],
      }),
    ]);
    renderDetails(fixing.id, source);

    const [tier2] = await screen.findAllByRole('list', { name: 'Tier 2 steps' });
    const latest = within(tier2!.closest('section')!.parentElement!);
    expect(latest.getAllByText('Running').length).toBeGreaterThan(0);
    expect(latest.queryByText('Timed out')).toBeNull();
    // A finished run's step with no exit code did time out.
    const tier1 = screen.getByRole('list', { name: 'Tier 1 steps' });
    expect(within(tier1).getByText('Timed out')).toBeTruthy();
  });

  it('shows each step as the daemon sends it, without a reload', async () => {
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [run(1, 'running', { steps: [step(0, 'ls -la')] })]);
    renderDetails(fixing.id, source);
    expect(await screen.findByText('ls -la')).toBeTruthy();
    const loads = source.loads.runs;

    source.sendRun('run.step', { v: 1, step: step(1, 'git diff') });
    expect(await screen.findByText('git diff')).toBeTruthy();
    // A step of another issue's run, and one that breaks the contract, change nothing.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    source.sendRun('run.step', {
      v: 1,
      step: { ...step(0, 'rm -rf /'), runId: '90000000-2222-4222-8222-222222222222' },
    });
    source.sendRun('run.step', { v: 1, step: { ...step(2, 'pwd'), seq: -1 } });
    expect(screen.queryByText('rm -rf /')).toBeNull();
    expect(screen.queryByText('pwd')).toBeNull();
    expect(source.loads.runs).toBe(loads);
  });

  it('adds a run of this issue when it starts, and shows its result when it finishes', async () => {
    const source = testSource([fixing, fresh]);
    renderDetails(fixing.id, source);
    expect(await screen.findByText('No agent has worked on this incident yet.')).toBeTruthy();

    const started = run(2, 'running', {});
    const row: Run = {
      id: started.id,
      issueId: started.issueId,
      tier: started.tier,
      status: started.status,
      startedAt: started.startedAt,
      finishedAt: null,
      prUrl: null,
      confidence: null,
    };
    source.sendRun('run.started', { v: 1, run: row });
    source.sendRun('run.step', { v: 1, step: { ...step(0, 'cat -n x.ts'), runId: started.id } });
    expect(await screen.findByRole('list', { name: 'Tier 2 steps' })).toBeTruthy();

    source.sendRun('run.finished', {
      v: 1,
      run: { ...row, status: 'escalated', finishedAt: '2026-11-22T09:04:00.000Z' },
      note: null,
    });
    expect(await screen.findByText('Escalated')).toBeTruthy();
  });

  it('loads the runs again after the socket reconnects, for the steps it missed', async () => {
    const source = testSource([fixing, fresh]);
    source.runs.set(fixing.id, [run(1, 'running', { steps: [step(0, 'ls -la')] })]);
    renderDetails(fixing.id, source);
    expect(await screen.findByText('ls -la')).toBeTruthy();

    // Sent while the tab was away, so only the database has them.
    source.runs.set(fixing.id, [
      run(1, 'running', { steps: [step(0, 'ls -la'), step(1, 'git diff'), step(2, 'pwd')] }),
    ]);
    source.reconnect();
    expect(await screen.findByText('git diff')).toBeTruthy();
    expect(screen.getByText('pwd')).toBeTruthy();
  });

  it('lists what happened to the issue in the activity panel', async () => {
    const source = testSource([fixing, fresh]);
    const at = (m: number) => `2026-11-22T09:0${m}:00.000Z`;
    const record = (id: string, event: object, currentTier: 1 | 2 | null, m: number) => ({
      id,
      issueId: fixing.id,
      event,
      fromStatus: 'new',
      toStatus: 'triaged',
      currentTier,
      createdAt: at(m),
    });
    source.events.set(fixing.id, [
      record('1', { type: 'triage', class: 'database', severity: 'critical' }, null, 1),
      record('2', { type: 'start_fix' }, 1, 2),
      record('3', { type: 'escalate', runId: fixing.id, reason: 'tests still fail' }, 2, 3),
    ] as never);
    renderDetails(fixing.id, source);

    const activity = within(await screen.findByRole('list', { name: 'Activity' }));
    expect(await activity.findByText('Escalated to Tier 2')).toBeTruthy();
    expect(activity.getByText('Error reported')).toBeTruthy();
    expect(activity.getByText('Database, Critical')).toBeTruthy();
    expect(activity.getByText('Tier 1 fix started')).toBeTruthy();
    expect(activity.getByText('tests still fail')).toBeTruthy();
  });

  describe('review', () => {
    const waiting = issue(3, {
      status: 'awaiting_approval',
      class: 'database',
      severity: 'critical',
      currentTier: 1,
    });

    it('sends review to the PR on GitHub when the fix has one', async () => {
      const source = testSource([fixing, waiting]);
      const run: IssueRun = {
        ...runFixture,
        issueId: waiting.id,
        prUrl: 'https://github.com/o/page-demo/pull/7',
        diff: null,
        steps: [],
        chats: [],
      };
      source.runs.set(waiting.id, [run]);
      renderDetails(waiting.id, source);

      const link = await screen.findByRole('link', { name: 'Review on GitHub' });
      const review = screen.getByRole('region', { name: 'Review' });
      expect(link.getAttribute('href')).toBe('https://github.com/o/page-demo/pull/7');
      expect(within(review).queryByRole('button', { name: 'Approve' })).toBeNull();
    });

    it('shows Approve and Reject only while a fix waits for review', () => {
      renderDetails(waiting.id, testSource([fixing, waiting]));
      expect(screen.getByRole('region', { name: 'Review' })).toBeTruthy();
      cleanup();

      renderDetails(fixing.id);
      expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    });

    it('approves, and the page shows the issue resolved', async () => {
      const source = renderDetails(waiting.id, testSource([fixing, waiting]));

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

      expect(await screen.findByText('Resolved')).toBeTruthy();
      expect(source.applied).toEqual([{ id: waiting.id, event: { type: 'approve' } }]);
      expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
    });

    it('rejects only with a reason, and sends it trimmed', async () => {
      const source = renderDetails(waiting.id, testSource([fixing, waiting]));

      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      const submit = screen.getByRole('button', { name: 'Reject fix' });
      expect((submit as HTMLButtonElement).disabled).toBe(true);

      fireEvent.change(screen.getByLabelText('Why is the fix wrong?'), {
        target: { value: '  breaks the slug lookup  ' },
      });
      fireEvent.click(submit);

      expect(await screen.findByText('Fixing')).toBeTruthy();
      expect(source.applied).toEqual([
        { id: waiting.id, event: { type: 'reject', reason: 'breaks the slug lookup' } },
      ]);
    });

    it("shows the server's reason when it refuses", async () => {
      const source = testSource([fixing, waiting]);
      source.respond = () => Promise.reject(new Error('cannot approve an issue that is fixing'));
      renderDetails(waiting.id, source);

      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

      expect((await screen.findByRole('alert')).textContent).toBe(
        'cannot approve an issue that is fixing',
      );
      expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    });
  });

  it('shows a Tier 3 request apart from patch review, which a fixing issue has none of', async () => {
    const tier3 = issue(3, { status: 'fixing', currentTier: 3 });
    const source = testSource([tier3]);
    source.approvals.set(tier3.id, [
      {
        id: '0000000a-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        runId: '30000000-2222-4222-8222-222222222222',
        issueId: tier3.id,
        action: 'ops.restart',
        args: { tool: 'ops.restart' },
        requestedAt: '2026-11-22T09:00:00.000Z',
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        reason: 'A restart loads the corrected setting.',
        decision: 'pending',
        decidedBy: null,
        decidedAt: null,
      },
    ]);
    renderDetails(tier3.id, source);

    const bar = await screen.findByRole('region', {
      name: 'Live app actions waiting for approval',
    });
    expect(within(bar).getByText('Restart the live app')).toBeTruthy();
    expect(within(bar).getByText('A restart loads the corrected setting.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Review' })).toBeNull();
  });

  it('updates live from issue.updated', () => {
    const source = renderDetails(fixing.id);

    source.send({
      v: 1,
      issue: {
        ...fixing,
        status: 'awaiting_approval',
        occurrences: 25,
        updatedAt: '2026-11-22T12:00:00.000Z',
      },
    });

    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(metric('Occurrences').getByText('25')).toBeTruthy();
  });

  it('fetches an issue the list does not hold', async () => {
    const old = issue(40, { title: 'An old one' });
    const source = testSource([fixing]);
    source.extra.set(old.id, old);

    renderDetails(old.id, source);

    expect(await screen.findByRole('heading', { name: 'An old one' })).toBeTruthy();
  });

  it('says the incident does not exist once the lookup finds nothing', async () => {
    renderDetails('INC-001');

    expect(await screen.findByRole('heading', { name: 'Incident not found' })).toBeTruthy();
    const back = screen.getByRole('link', { name: 'Back to Incidents' });
    expect(back.getAttribute('href')).toBe('/incidents');
    expect(back.closest('button')).toBeNull();
  });

  it('asks for the token instead of saying not found', () => {
    renderDetails(fixing.id, testSource([], 'needs_token'));

    expect(screen.getByLabelText('Personal or API token')).toBeTruthy();
    expect(screen.queryByText('Loading incident...')).toBeNull();
  });

  it('asks for a token above an incident it already shows, once the token is gone', () => {
    const source = testSource([fixing]);
    renderDetails(fixing.id, source);
    expect(screen.queryByLabelText('Personal or API token')).toBeNull();

    source.setStatus('needs_token');
    expect(screen.getByLabelText('Personal or API token')).toBeTruthy();
    expect(screen.getByRole('heading', { name: fixing.title })).toBeTruthy();
  });

  it('renders a back link to the incidents page', () => {
    renderDetails(fixing.id);

    expect(screen.getByRole('link', { name: 'Back to Incidents' }).getAttribute('href')).toBe(
      '/incidents',
    );
  });
});
