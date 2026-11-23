// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';

import DashboardPage from './DashboardPage';
import { initialMockTasks } from '../data/mockTasks';
import { issue, renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
});

const issues = [1, 2, 3, 4, 5, 6].map((n) =>
  issue(n, n === 1 ? { status: 'resolved' } : { severity: n % 2 ? 'critical' : 'medium' }),
);

function renderDashboard(list = issues) {
  const source = testSource(list);
  renderWithIssues(<DashboardPage />, source);
  return source;
}

describe('DashboardPage', () => {
  it('renders all four metric cards', () => {
    renderDashboard();

    expect(screen.getByText('Total Incidents')).toBeTruthy();
    expect(screen.getByText('Active Incidents')).toBeTruthy();
    expect(screen.getByText('Running Agents')).toBeTruthy();
    expect(screen.getByText('Queued Tasks')).toBeTruthy();
  });

  it('describes the Queued Tasks card with the task total', () => {
    renderDashboard();

    const card = screen.getByText('Queued Tasks').closest('[data-slot="card"]') as HTMLElement;
    const total = initialMockTasks.length;

    expect(within(card).getByText(`${total} total ${total === 1 ? 'task' : 'tasks'}`)).toBeTruthy();
    expect(within(card).queryByText(/resolved incidents/)).toBeNull();
  });

  it('describes the Running Agents card with a correctly pluralised task count', () => {
    renderDashboard();

    const card = screen.getByText('Running Agents').closest('[data-slot="card"]') as HTMLElement;
    const running = initialMockTasks.filter((task) => task.status === 'Running').length;

    expect(
      within(card).getByText(`${running} ${running === 1 ? 'task' : 'tasks'} running`),
    ).toBeTruthy();
  });

  it('lists the five most recently updated incidents, newest first', () => {
    renderDashboard();

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
    renderDashboard();

    const total = screen.getByText('Total Incidents').closest('[data-slot="card"]') as HTMLElement;
    const active = screen
      .getByText('Active Incidents')
      .closest('[data-slot="card"]') as HTMLElement;
    expect(within(total).getByText('6')).toBeTruthy();
    expect(within(active).getByText('5')).toBeTruthy();
  });

  it('displays incident severity and status with colors for both themes', () => {
    renderDashboard();

    const critical = screen.getAllByText('Critical');
    expect(critical.length).toBeGreaterThan(0);
    for (const badge of critical) {
      expect(badge.className).toContain('bg-red-100');
      expect(badge.className).toContain('dark:border-red-900');
    }
    expect(screen.getAllByText('Fixing')[0]!.className).toContain('dark:border-purple-900');
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
    renderDashboard([]);

    expect(screen.getByText('No incidents yet.')).toBeTruthy();
  });

  it('renders the AgentOverview component', () => {
    renderDashboard();

    expect(screen.getByText('AI Agents')).toBeTruthy();
    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
  });
});
