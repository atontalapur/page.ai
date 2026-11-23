// @vitest-environment jsdom
import { TaskProvider } from '../context/TaskContext';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';

import DashboardPage from './DashboardPage';
import { mockIncidents } from '../data/mockIncidents';
import { initialMockTasks } from '../data/mockTasks';

afterEach(() => {
  cleanup();
});

function renderDashboard() {
  return render(
    <MemoryRouter>
      <TaskProvider>
        <DashboardPage />
      </TaskProvider>
    </MemoryRouter>,
  );
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

  it('lists recent incidents newest first without reordering the source data', () => {
    const sourceOrder = mockIncidents.map((incident) => incident.id);

    renderDashboard();

    const table = screen.getByText('Recent Incidents').closest('[data-slot="card"]') as HTMLElement;
    const rowIds = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getByRole('link').textContent);

    const expected = [...mockIncidents]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 5)
      .map((incident) => incident.id);

    expect(rowIds).toEqual(expected);
    expect(rowIds[0]).toBe('INC-005');
    expect(mockIncidents.map((incident) => incident.id)).toEqual(sourceOrder);
  });

  it('renders the recent incidents table', () => {
    renderDashboard();

    expect(screen.getByText('Recent Incidents')).toBeTruthy();
    expect(screen.getByText('Database connection timeout')).toBeTruthy();
    expect(screen.getByText('API response latency')).toBeTruthy();
  });

  it('displays incident severity and status', () => {
    renderDashboard();

    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Medium').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Investigating').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Open').length).toBeGreaterThan(0);
  });

  it('applies severity colors correctly', () => {
    renderDashboard();

    const criticalBadges = screen.getAllByText('Critical');
    const mediumBadges = screen.getAllByText('Medium');

    criticalBadges.forEach((badge) => {
      expect(badge.className).toContain('bg-red-100');
    });

    mediumBadges.forEach((badge) => {
      expect(badge.className).toContain('bg-yellow-100');
    });
  });

  it('gives incident badges dark mode variants', () => {
    renderDashboard();

    expect(screen.getAllByText('Critical')[0]!.className).toContain('dark:bg-red-950');
    expect(screen.getAllByText('Investigating')[0]!.className).toContain('dark:bg-purple-950');
  });

  it('renders the AgentOverview component', () => {
    renderDashboard();

    expect(screen.getByText('AI Agents')).toBeTruthy();
    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
  });
});
