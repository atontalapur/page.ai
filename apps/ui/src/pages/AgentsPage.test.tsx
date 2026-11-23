// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { Step } from '@page/contracts';
import { stepFixture } from '@page/contracts/fixtures';

import AgentsPage from './AgentsPage';
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
const triaged = issue(2, { title: 'RangeError: bad date', status: 'triaged', severity: 'high' });
const held = nodeRun(1, fixing, {
  tier: 2,
  stepCount: 3,
  lastStep: { ...stepFixture, seq: 2, input: 'cat -n src/shop/products.ts', exitCode: 0 },
});

const busy = daemon('busy-node', { current: [held], lastRunAt: held.startedAt });
const idle = daemon('idle-node', { lastRunAt: '2026-11-22T07:00:00.000Z' });
const gone = daemon('gone-node', { connected: false, since: null });

function renderAgents(
  source: TestSource = testSource([fixing, triaged], 'live', [gone, idle, busy]),
) {
  renderWithIssues(<AgentsPage />, source);
  return source;
}

/** The card of the agent called `name`. */
function card(name: string) {
  const title = screen.getByText(name, { selector: '[data-slot="card-title"]' });
  return within(title.closest('[data-slot="card"]') as HTMLElement);
}

function metric(label: string) {
  const title = screen.getByText(label, { selector: '[data-slot="card-title"]' });
  return within(title.closest('[data-slot="card"]') as HTMLElement);
}

const step = (seq: number, input: string): Step => ({ ...stepFixture, runId: held.id, seq, input });

describe('AgentsPage', () => {
  it('lists each daemon, running first, with what it is doing', () => {
    renderAgents();

    const titles = Array.from(document.querySelectorAll('[data-slot="card-title"]'))
      .map((t) => t.textContent)
      .filter((t) => t?.endsWith('-node'));
    expect(titles).toEqual(['busy-node', 'idle-node', 'gone-node']);

    const running = card('busy-node');
    // The agent's badge, and its run's.
    expect(running.getAllByText('Running', { selector: '[data-slot="badge"]' })).toHaveLength(2);
    const link = running.getByRole('link', { name: /price is undefined/ });
    expect(link.getAttribute('href')).toBe(`/incidents/${fixing.id}`);
    expect(running.getByText('Tier 2')).toBeTruthy();
    expect(running.getByText('3 steps')).toBeTruthy();
    expect(running.getByText('Read src/shop/products.ts')).toBeTruthy();
    expect(running.getByText('OK')).toBeTruthy();
    expect(running.getByRole('link', { name: 'View agent' }).getAttribute('href')).toBe(
      '/agents/busy-node',
    );

    expect(card('idle-node').getByText('Idle')).toBeTruthy();
    expect(card('idle-node').getByText('No run in progress')).toBeTruthy();
    expect(card('idle-node').getByText(/^Last run started /)).toBeTruthy();
    expect(
      card('gone-node').getByText('Offline', { selector: '[data-slot="badge"]' }),
    ).toBeTruthy();
    expect(card('gone-node').getByText('No runs yet')).toBeTruthy();

    expect(metric('Agents').getByText('3')).toBeTruthy();
    expect(metric('Running').getByText('1')).toBeTruthy();
    expect(metric('Idle').getByText('1')).toBeTruthy();
    expect(metric('Offline').getByText('1')).toBeTruthy();
  });

  it('updates without a reload as daemons connect, leave and write steps', async () => {
    const source = renderAgents();

    source.sendNode({ v: 1, node: daemon('new-node') });
    expect(await screen.findByText('new-node')).toBeTruthy();

    source.sendNode({
      v: 1,
      node: { ...idle, connected: false, since: '2026-11-22T10:00:00.000Z' },
    });
    expect(card('idle-node').getByText(/^Offline since /)).toBeTruthy();

    source.sendRun('run.step', { v: 1, step: step(3, 'pnpm --filter @page/demo-app lint') });
    expect(card('busy-node').getByText('4 steps')).toBeTruthy();
    expect(card('busy-node').getByText('Lint demo app')).toBeTruthy();

    // The daemon lets its run go once it finishes.
    source.sendNode({ v: 1, node: { ...busy, current: [] } });
    expect(card('busy-node').getByText('No run in progress')).toBeTruthy();
    expect(metric('Running').getByText('0')).toBeTruthy();
  });

  it('drops a node.updated that breaks the contract', () => {
    const source = renderAgents();
    source.sendNode({ v: 1, node: { ...idle, name: 'not a name' } });
    expect(screen.queryByText('not a name')).toBeNull();
  });

  it('loads the daemons again after the socket reconnects', async () => {
    const source = renderAgents();
    source.nodes = [daemon('fresh-node')];
    source.reconnect();
    expect(await screen.findByText('fresh-node')).toBeTruthy();
    expect(screen.queryByText('busy-node')).toBeNull();
  });

  it('filters by name and by status', () => {
    renderAgents();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: 'IDLE' },
    });
    expect(screen.getByText('idle-node')).toBeTruthy();
    expect(screen.queryByText('busy-node')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter agents by status'), {
      target: { value: 'offline' },
    });
    expect(screen.getByText('gone-node')).toBeTruthy();
    expect(screen.queryByText('idle-node')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: 'nobody' },
    });
    expect(screen.getByText('No agents match your search or filters.')).toBeTruthy();
  });

  it('says how to start a daemon when none has connected', () => {
    renderAgents(testSource([], 'live', []));
    expect(screen.getByText(/No node daemon has connected yet/)).toBeTruthy();
  });

  it('asks for the token, rather than saying there are no agents, when it has none', () => {
    renderAgents(testSource([], 'needs_token'));
    expect(screen.getByText('Connect to the orchestrator to see its agents.')).toBeTruthy();
  });

  it('starts a fix on a triaged incident, the only real action an agent takes on request', async () => {
    const source = renderAgents();

    fireEvent.click(screen.getByRole('button', { name: 'Start a fix' }));
    const dialog = within(await screen.findByRole('dialog'));
    const select = dialog.getByLabelText<HTMLSelectElement>('Incident');
    // Only triaged incidents are offered.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['', triaged.id]);

    fireEvent.change(select, { target: { value: triaged.id } });
    fireEvent.click(dialog.getByRole('button', { name: 'Start fix' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(source.applied).toEqual([{ id: triaged.id, event: { type: 'start_fix' } }]);
  });

  it('starts a fix on the agent chosen, offering only connected agents', async () => {
    const source = renderAgents();

    fireEvent.click(screen.getByRole('button', { name: 'Start a fix' }));
    const dialog = within(await screen.findByRole('dialog'));
    const agent = dialog.getByLabelText<HTMLSelectElement>('Agent');
    // Any agent first, then each connected daemon; the one that left is not offered.
    expect(Array.from(agent.options).map((o) => o.value)).toEqual(['', 'busy-node', 'idle-node']);

    fireEvent.change(dialog.getByLabelText('Incident'), { target: { value: triaged.id } });
    fireEvent.change(agent, { target: { value: 'idle-node' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Start fix' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(source.applied).toEqual([
      { id: triaged.id, event: { type: 'start_fix', node: 'idle-node' } },
    ]);
  });

  it("stops a busy agent's run once asked to confirm, by killing its incident", async () => {
    const source = renderAgents();

    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(source.applied).toEqual([]);
    const confirm = within(screen.getByRole('group', { name: 'Stop this run' }));
    fireEvent.click(confirm.getByRole('button', { name: 'Stop run' }));

    await waitFor(() =>
      expect(source.applied).toEqual([{ id: fixing.id, event: { type: 'kill' } }]),
    );
  });

  it('leaves a finished run off the card, so it cannot be killed again', () => {
    const stuck = daemon('railway-staging', {
      current: [
        nodeRun(1, fixing, { status: 'escalated', stepCount: 38 }),
        nodeRun(2, fixing, { tier: 2, status: 'killed', stepCount: 17 }),
      ],
      lastRunAt: '2026-11-22T09:00:00.000Z',
    });
    renderAgents(testSource([fixing], 'live', [stuck]));

    const agent = card('railway-staging');
    expect(agent.getByText('Idle', { selector: '[data-slot="badge"]' })).toBeTruthy();
    expect(agent.getByText('No run in progress')).toBeTruthy();
    expect(agent.queryByRole('button', { name: 'Stop run' })).toBeNull();
    expect(agent.queryByText('Escalated')).toBeNull();
    expect(agent.queryByText('Killed')).toBeNull();
    expect(metric('Running').getByText('0')).toBeTruthy();
    expect(metric('Idle').getByText('1')).toBeTruthy();
  });

  it('keeps the run going when the stop is cancelled', () => {
    const source = renderAgents();

    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep running' }));
    expect(screen.getByRole('button', { name: 'Stop run' })).toBeTruthy();
    expect(source.applied).toEqual([]);
  });

  it('shows why the orchestrator refused to start a fix', async () => {
    const source = testSource([fixing, triaged], 'live', []);
    source.respond = () => Promise.reject(new Error('fix starts are capped for this hour'));
    renderAgents(source);

    fireEvent.click(screen.getByRole('button', { name: 'Start a fix' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText('Incident'), { target: { value: triaged.id } });
    fireEvent.click(dialog.getByRole('button', { name: 'Start fix' }));
    expect((await dialog.findByRole('alert')).textContent).toBe(
      'fix starts are capped for this hour',
    );
  });

  it('says so when no incident is waiting for a fix', async () => {
    renderAgents(testSource([fixing], 'live', []));
    fireEvent.click(screen.getByRole('button', { name: 'Start a fix' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('No incident is triaged and waiting for a fix.')).toBeTruthy();
    const start = dialog.getByRole<HTMLButtonElement>('button', { name: 'Start fix' });
    expect(start.disabled).toBe(true);
  });
});
