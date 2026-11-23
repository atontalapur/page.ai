// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { IssueRun, Step } from '@page/contracts';
import { stepFixture } from '@page/contracts/fixtures';

// jsdom can't run the highlighter; these stand in for its views.
vi.mock('@pierre/diffs/react', () => ({
  PatchDiff: ({ patch }: { patch: string }) => <pre data-testid="patch-diff">{patch}</pre>,
  MultiFileDiff: () => <pre data-testid="edit-diff" />,
}));

import AgentWorkspacePage from './AgentWorkspacePage';
import {
  daemon,
  issue,
  nodeRun,
  renderWithIssues,
  testSource,
  type TestSource,
} from '../test-utils';

afterEach(() => {
  cleanup();
});

const fixing = issue(1, { title: 'TypeError: price is undefined', status: 'fixing' });
const older = issue(2, { title: 'RangeError: bad date', status: 'failed' });
const held = nodeRun(1, fixing, { stepCount: 1 });
const done = nodeRun(2, older, {
  status: 'escalated',
  stepCount: 5,
  finishedAt: '2026-11-22T09:05:00.000Z',
});

const step = (seq: number, input: string): Step => ({ ...stepFixture, runId: held.id, seq, input });

const fullRun: IssueRun = {
  id: held.id,
  issueId: fixing.id,
  tier: 1,
  status: 'running',
  startedAt: held.startedAt,
  finishedAt: null,
  prUrl: null,
  confidence: null,
  diff: null,
  steps: [step(0, 'ls -la')],
  chats: [],
};

const busy = daemon('busy-node', { current: [held], lastRunAt: held.startedAt });

function renderAgent(name: string, source: TestSource) {
  renderWithIssues(<AgentWorkspacePage />, source, {
    path: `/agents/${name}`,
    route: '/agents/:id',
  });
  return source;
}

function busySource() {
  const source = testSource([fixing, older], 'live', [busy, daemon('idle-node')]);
  source.runs.set(fixing.id, [fullRun]);
  source.nodeRuns.set('busy-node', [held, done]);
  return source;
}

function recent() {
  return within(screen.getByRole('table', { name: 'Recent runs' }));
}

describe('AgentWorkspacePage', () => {
  it('shows the daemon, the run it holds with its steps, and the runs it worked', async () => {
    renderAgent('busy-node', busySource());

    const heading = screen.getByRole('heading', { name: 'busy-node' });
    const header = heading.closest('.justify-between') as HTMLElement;
    expect(within(header).getByText('Running', { selector: '[data-slot="badge"]' })).toBeTruthy();
    expect(screen.getByText(/^Connected since /)).toBeTruthy();
    expect(await screen.findByText('$ ls -la')).toBeTruthy();
    const incident = screen.getAllByRole('link', { name: /price is undefined/ })[0]!;
    expect(incident.getAttribute('href')).toBe(`/incidents/${fixing.id}`);

    await waitFor(() => expect(recent().getAllByRole('row')).toHaveLength(3));
    expect(recent().getByText('Escalated')).toBeTruthy();
    expect(recent().getByText('5')).toBeTruthy();
    expect(
      recent()
        .getByRole('link', { name: /bad date/ })
        .getAttribute('href'),
    ).toBe(`/incidents/${older.id}`);
  });

  it('streams the current run as the daemon sends steps, without a reload', async () => {
    const source = renderAgent('busy-node', busySource());
    expect(await screen.findByText('$ ls -la')).toBeTruthy();
    await waitFor(() => expect(recent().getAllByRole('row')).toHaveLength(3));
    const loads = { ...source.loads };

    source.sendRun('run.step', { v: 1, step: step(1, 'git diff') });
    expect(await screen.findByText('$ git diff')).toBeTruthy();
    // The history row counts it too.
    expect(within(recent().getAllByRole('row')[1]!).getByText('2')).toBeTruthy();

    const finished = {
      id: held.id,
      issueId: fixing.id,
      tier: 1,
      status: 'succeeded',
      startedAt: held.startedAt,
      finishedAt: '2026-11-22T09:06:00.000Z',
      prUrl: null,
      confidence: null,
    };
    source.sendRun('run.finished', { v: 1, run: finished, note: null });
    expect(await recent().findByText('Patch ready')).toBeTruthy();
    expect(source.loads).toEqual(loads);
  });

  it('loads its runs again when the daemon takes a new one, and after a reconnect', async () => {
    const source = renderAgent('busy-node', busySource());
    expect(await screen.findByText('$ ls -la')).toBeTruthy();
    await waitFor(() => expect(source.loads.nodeRuns).toBe(1));

    source.sendNode({ v: 1, node: { ...busy, lastRunAt: '2026-11-22T10:00:00.000Z' } });
    await waitFor(() => expect(source.loads.nodeRuns).toBe(2));

    // Steps sent while the tab was away reach it from the database.
    source.runs.set(fixing.id, [{ ...fullRun, steps: [step(0, 'ls -la'), step(1, 'pwd')] }]);
    source.reconnect();
    expect(await screen.findByText('$ pwd')).toBeTruthy();
    await waitFor(() => expect(source.loads.nodeRuns).toBe(3));
  });

  it('says when an idle or offline daemon runs nothing', async () => {
    const source = testSource([], 'live', [
      daemon('idle-node'),
      daemon('gone-node', { connected: false, since: null }),
    ]);
    renderAgent('idle-node', source);
    expect(screen.getByText(/No run in progress/)).toBeTruthy();
    expect(await screen.findByText('This agent has not worked a run yet.')).toBeTruthy();
    cleanup();

    renderAgent('gone-node', source);
    expect(screen.getByText('The agent is offline, so it is not running anything.')).toBeTruthy();
    expect(screen.getByText('Offline', { selector: 'p' })).toBeTruthy();
  });

  it('says so for a name no daemon has used, and waits for the list before deciding', () => {
    renderAgent('nobody', testSource([], 'live', []));
    expect(screen.getByRole('heading', { name: 'Agent not found' })).toBeTruthy();
    cleanup();

    renderAgent('nobody', testSource([], 'needs_token'));
    expect(screen.queryByText('Agent not found')).toBeNull();
    expect(screen.getByText('Connect to the orchestrator')).toBeTruthy();
  });
});
