// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import type { NodeSummary } from '@page/contracts';

import DashboardPage from './DashboardPage';
import { daemon, issue, nodeRun, renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
});

const issues = [1, 2, 3, 4, 5, 6].map((n) =>
  issue(n, n === 1 ? { status: 'resolved' } : { severity: n % 2 ? 'critical' : 'medium' }),
);
const awaiting = issue(7, {
  status: 'awaiting_approval',
  updatedAt: '2026-11-22T08:00:00.000Z',
});

const nodes: NodeSummary[] = [
  daemon('busy-node', { current: [nodeRun(1, issues[1]!)] }),
  daemon('idle-node'),
  daemon('gone-node', { connected: false }),
];

function renderDashboard(list = [...issues, awaiting], daemons = nodes) {
  const source = testSource(list, 'live', daemons);
  renderWithIssues(<DashboardPage />, source);
  return source;
}

function metric(title: string) {
  return within(screen.getByText(title).closest('[data-slot="card"]') as HTMLElement);
}

describe('DashboardPage', () => {
  it('renders all four metric cards', () => {
    renderDashboard();

    expect(screen.getByText('Total Incidents')).toBeTruthy();
    expect(screen.getByText('Active Incidents')).toBeTruthy();
    expect(screen.getByText('Running Agents')).toBeTruthy();
    expect(screen.getByText('Fixes in Progress')).toBeTruthy();
  });

  it('counts running agents from the live daemons', () => {
    renderDashboard();

    expect(metric('Running Agents').getByText('1')).toBeTruthy();
    expect(metric('Running Agents').getByText('2 of 3 connected')).toBeTruthy();
  });

  it('counts fixes in progress and those awaiting review', () => {
    renderDashboard();

    // Every issue but the resolved one and the one awaiting review is fixing by default.
    expect(metric('Fixes in Progress').getByText('5')).toBeTruthy();
    expect(metric('Fixes in Progress').getByText('1 awaiting review')).toBeTruthy();
  });

  it('updates the agent figures live as a daemon connects or takes a run', () => {
    const source = renderDashboard();

    source.sendNode({
      v: 1,
      node: daemon('idle-node', { current: [nodeRun(2, issues[2]!)] }),
    });
    expect(metric('Running Agents').getByText('2')).toBeTruthy();
    expect(within(screen.getByTestId('running-count')).getByText('2')).toBeTruthy();
  });

  it('lists the five most recently updated incidents, newest first', () => {
    renderDashboard(issues);

    const table = screen.getByText('Recent Incidents').closest('[data-slot="card"]') as HTMLElement;
    const rowIds = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByRole('link').textContent);

    expect(rowIds).toEqual(['00000006', '00000005', '00000004', '00000003', '00000002']);
    expect(within(table).getByRole('link', { name: '00000006' }).getAttribute('href')).toBe(
      `/incidents/${issues[5]!.id}`,
    );
  });

  it('counts total and active incidents from the live issues', () => {
    renderDashboard(issues);

    expect(metric('Total Incidents').getByText('6')).toBeTruthy();
    expect(metric('Active Incidents').getByText('5')).toBeTruthy();
  });

  it('displays incident severity and status with colors for both themes', () => {
    renderDashboard();

    const critical = screen.getAllByText('Critical');
    expect(critical.length).toBeGreaterThan(0);
    for (const badge of critical) {
      expect(badge.className).toContain('bg-red-a3');
      expect(badge.className).toContain('text-red-11');
    }
    expect(screen.getAllByText('Fixing')[0]!.className).toContain('bg-violet-a3');
  });

  it('updates a recent incident live', () => {
    const source = renderDashboard();

    source.send({
      v: 1,
      issue: { ...issues[1]!, status: 'killed', updatedAt: '2026-11-22T12:00:00.000Z' },
    });

    const table = screen.getByText('Recent Incidents').closest('[data-slot="card"]') as HTMLElement;
    const first = within(table).getAllByRole('row')[1]!;
    expect(within(first).getByText('Killed')).toBeTruthy();
  });

  it('says so when there are no incidents yet', () => {
    renderDashboard([], []);

    expect(screen.getByText('No incidents yet.')).toBeTruthy();
    expect(screen.getByText('No node daemon has connected yet.')).toBeTruthy();
  });

  it('shows the agents card with the live daemons', () => {
    renderDashboard();

    expect(screen.getByText('3 node daemons')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'busy-node' })).toBeTruthy();
  });
});
