// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import AgentsPage from './AgentsPage';
import { TaskProvider } from '../context/TaskContext';
import { mockAgents } from '../data/mockAgents';

afterEach(() => {
  cleanup();
});

function renderAgentsPage() {
  return render(
    <MemoryRouter>
      <TaskProvider>
        <AgentsPage />
      </TaskProvider>
    </MemoryRouter>,
  );
}

describe('AgentsPage', () => {
  it('renders the page heading', () => {
    renderAgentsPage();

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy();

    expect(screen.getByText('Monitor AI agents and their current investigations.')).toBeTruthy();
  });

  it('renders all agent metrics', () => {
    renderAgentsPage();

    expect(screen.getByText('Total Agents')).toBeTruthy();

    const running = mockAgents.filter((agent) => agent.status === 'Running').length;

    const idle = mockAgents.filter((agent) => agent.status === 'Idle').length;

    const failed = mockAgents.filter((agent) => agent.status === 'Failed').length;

    expect(mockAgents).toHaveLength(4);
    expect(running).toBe(2);
    expect(idle).toBe(1);
    expect(failed).toBe(1);
  });

  it('renders all four agents', () => {
    renderAgentsPage();

    for (const agent of mockAgents) {
      expect(screen.getByText(agent.name)).toBeTruthy();
    }
  });

  it('filters agents by name', () => {
    renderAgentsPage();

    const searchInput = screen.getByPlaceholderText('Search agents...');

    fireEvent.change(searchInput, {
      target: { value: 'Diagnostic' },
    });

    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();

    expect(screen.queryByText('Fix Agent')).toBeNull();
    expect(screen.queryByText('Review Agent')).toBeNull();
    expect(screen.queryByText('Monitoring Agent')).toBeNull();
  });

  it('filters agents by ID', () => {
    renderAgentsPage();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: 'AG-003' },
    });

    expect(screen.getByText('Review Agent')).toBeTruthy();

    expect(screen.queryByText('Diagnostic Agent')).toBeNull();
    expect(screen.queryByText('Fix Agent')).toBeNull();
  });

  it('filters agents by status', () => {
    renderAgentsPage();

    const statusFilter = screen.getByRole('combobox', {
      name: 'Filter agents by status',
    });

    fireEvent.change(statusFilter, {
      target: { value: 'Idle' },
    });

    expect(screen.getByText('Review Agent')).toBeTruthy();

    expect(screen.queryByText('Diagnostic Agent')).toBeNull();
    expect(screen.queryByText('Fix Agent')).toBeNull();
    expect(screen.queryByText('Monitoring Agent')).toBeNull();
  });

  it('displays an empty state when no agents match', () => {
    renderAgentsPage();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: 'nonexistent-agent-xyz' },
    });

    expect(screen.getByText('No agents match your search or filters.')).toBeTruthy();
  });

  it('gives agent status badges dark mode variants', () => {
    renderAgentsPage();

    const badges = Array.from(document.querySelectorAll('[data-slot="badge"]'));

    expect(badges).toHaveLength(mockAgents.length);

    for (const badge of badges) {
      expect(badge.className).toMatch(/dark:bg-\w+-(800|950)/);
    }
  });

  it('renders workspace links for every agent', () => {
    renderAgentsPage();

    const workspaceLinks = screen.getAllByRole('link', {
      name: 'View Workspace',
    });

    expect(workspaceLinks).toHaveLength(mockAgents.length);

    for (const agent of mockAgents) {
      const expectedPath = `/agents/${agent.id}`;

      expect(workspaceLinks.some((link) => link.getAttribute('href') === expectedPath)).toBe(true);
    }
  });

  it('renders incident links for assigned agents', () => {
    renderAgentsPage();

    const agentsWithIncidents = mockAgents.filter((agent) => agent.currentIncident !== null);

    for (const agent of agentsWithIncidents) {
      const incidentLinks = screen.getAllByRole('link', {
        name: agent.currentIncident!,
      });

      expect(
        incidentLinks.some(
          (link) => link.getAttribute('href') === `/incidents/${agent.currentIncident}`,
        ),
      ).toBe(true);
    }
  });

  it('opens the assignment dialog', () => {
    renderAgentsPage();

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Assign Task' }));

    const dialog = screen.getByRole('dialog');

    expect(dialog).toBeTruthy();

    expect(within(dialog).getByText('Assign New Task')).toBeTruthy();
  });

  it('closes the assignment dialog', () => {
    renderAgentsPage();

    fireEvent.click(screen.getByRole('button', { name: 'Assign Task' }));

    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('combines search and status filtering', () => {
    renderAgentsPage();

    fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
      target: { value: 'Agent' },
    });

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Filter agents by status',
      }),
      {
        target: { value: 'Failed' },
      },
    );

    expect(screen.getByText('Monitoring Agent')).toBeTruthy();

    expect(screen.queryByText('Diagnostic Agent')).toBeNull();
    expect(screen.queryByText('Fix Agent')).toBeNull();
    expect(screen.queryByText('Review Agent')).toBeNull();
  });
});
