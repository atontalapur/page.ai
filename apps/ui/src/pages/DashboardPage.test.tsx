// @vitest-environment jsdom
import { TaskProvider } from '../context/TaskContext';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import DashboardPage from './DashboardPage';

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

  it('renders the AgentOverview component', () => {
    renderDashboard();

    expect(screen.getByText('AI Agents')).toBeTruthy();
    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
  });
});
