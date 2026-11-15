// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import AgentOverview, { type Agent } from './AgentOverview';

const mockAgents: Agent[] = [
  {
    id: 'AG-001',
    name: 'Diagnostic Agent',
    status: 'Running',
    task: 'Analyzing database timeout',
  },
  {
    id: 'AG-002',
    name: 'Fix Agent',
    status: 'Running',
    task: 'Generating patch',
  },
  {
    id: 'AG-003',
    name: 'Review Agent',
    status: 'Idle',
    task: 'Waiting for approval',
  },
  {
    id: 'AG-004',
    name: 'Monitoring Agent',
    status: 'Failed',
    task: 'Connection lost',
  },
];

afterEach(() => {
  cleanup();
});

describe('AgentOverview', () => {
  it('renders the AI Agents heading', () => {
    render(<AgentOverview agents={mockAgents} />);

    expect(screen.getByText('AI Agents')).toBeTruthy();
  });

  it('displays the total number of agents', () => {
    render(<AgentOverview agents={mockAgents} />);

    expect(screen.getByText('4 Total Agents')).toBeTruthy();
  });

  it('calculates agent status counts correctly', () => {
    const { container } = render(<AgentOverview agents={mockAgents} />);

    expect(container.textContent).toContain('2');
    expect(container.textContent).toContain('Running');
    expect(container.textContent).toContain('Idle');
    expect(container.textContent).toContain('Failed');
  });

  it('displays only the first three agents', () => {
    render(<AgentOverview agents={mockAgents} />);

    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
    expect(screen.getByText('Fix Agent')).toBeTruthy();
    expect(screen.getByText('Review Agent')).toBeTruthy();

    expect(screen.queryByText('Monitoring Agent')).toBeNull();
  });

  it('handles an empty agent list', () => {
    render(<AgentOverview agents={[]} />);

    expect(screen.getByText('0 Total Agents')).toBeTruthy();
    expect(screen.queryByText('Diagnostic Agent')).toBeNull();
  });

  it('applies the correct status badge colors', () => {
    render(<AgentOverview agents={mockAgents} />);

    const runningBadges = screen.getAllByText('Running');
    const idleBadges = screen.getAllByText('Idle');

    expect(runningBadges.some((element) => element.className.includes('bg-green-100'))).toBe(true);

    expect(idleBadges.some((element) => element.className.includes('bg-gray-100'))).toBe(true);
  });
});
