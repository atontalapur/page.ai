// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import DashboardPage from './DashboardPage';

afterEach(() => {
  cleanup();
});

describe('DashboardPage', () => {
  it('renders all four metric cards', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Total Incidents')).toBeTruthy();
    expect(screen.getByText('Active Incidents')).toBeTruthy();
    expect(screen.getByText('Active Agents')).toBeTruthy();
    expect(screen.getByText('Resolved Today')).toBeTruthy();
  });

  it('renders the recent incidents table', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Recent Incidents')).toBeTruthy();
    expect(screen.getByText('Database connection timeout')).toBeTruthy();

    expect(screen.getByText('API response latency')).toBeTruthy();
  });

  it('displays incident severity and status', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Medium')).toBeTruthy();
    expect(screen.getByText('Investigating')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
  });

  it('applies severity colors correctly', () => {
    render(<DashboardPage />);

    expect(screen.getByText('Critical').className).toContain('bg-red-100');

    expect(screen.getByText('Medium').className).toContain('bg-yellow-100');
  });

  it('renders the AgentOverview component', () => {
    render(<DashboardPage />);

    expect(screen.getByText('AI Agents')).toBeTruthy();
    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
  });
});
