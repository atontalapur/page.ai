// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import AgentWorkspacePage from './AgentWorkspacePage';
import { TaskProvider, useTasks } from '../context/TaskContext';
import { mockAgents } from '../data/mockAgents';
import { getExecutionByIncident } from '../data/mockExecution';

afterEach(() => {
  cleanup();
});

interface SeedTask {
  agentId: string;
  incidentId: string | null;
}

// Stands in for the Assign Task dialog: creates a task in the shared provider.
function TaskSeeder({ seed }: { seed: SeedTask }) {
  const { createTask } = useTasks();

  return (
    <button
      type="button"
      onClick={() =>
        createTask({
          title: `Investigate ${seed.incidentId ?? 'issue'}`,
          instructions: 'Find the root cause.',
          agentId: seed.agentId,
          incidentId: seed.incidentId,
          priority: 'High',
        })
      }
    >
      Seed Task
    </button>
  );
}

function renderWorkspace(agentId: string, seed?: SeedTask) {
  return render(
    <MemoryRouter initialEntries={[`/agents/${agentId}`]}>
      <TaskProvider>
        {seed && <TaskSeeder seed={seed} />}
        <Routes>
          <Route path="/agents/:id" element={<AgentWorkspacePage />} />
        </Routes>
      </TaskProvider>
    </MemoryRouter>,
  );
}

function getCard(title: string): HTMLElement {
  const card = screen.getByText(title).closest<HTMLElement>('[data-slot="card"]');

  if (!card) {
    throw new Error(`No card titled ${title}`);
  }

  return card;
}

function getStep(title: string): HTMLElement {
  const step = within(getCard('Execution Timeline')).getByText(title).closest('li');

  if (!step) {
    throw new Error(`No timeline step titled ${title}`);
  }

  return step;
}

function getAgentStatusBadge(agentName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: agentName });
  const badge = heading
    .closest('.justify-between')
    ?.querySelector<HTMLElement>('[data-slot="badge"]');

  if (!badge) {
    throw new Error(`No status badge for ${agentName}`);
  }

  return badge;
}

describe('AgentWorkspacePage', () => {
  it('renders the workspace for a valid agent', () => {
    renderWorkspace('AG-001');

    expect(screen.getByText('Diagnostic Agent')).toBeTruthy();
  });

  it('renders the correct agent based on the route', () => {
    renderWorkspace('AG-002');

    expect(screen.getByText('Fix Agent')).toBeTruthy();
  });

  it('renders the workspace for each mock agent', () => {
    for (const agent of mockAgents) {
      const { unmount } = renderWorkspace(agent.id);

      expect(screen.getByText(agent.name)).toBeTruthy();

      unmount();
    }
  });

  it('shows an assigned task once it starts, not the static Idle state', () => {
    renderWorkspace('AG-003', { agentId: 'AG-003', incidentId: 'INC-002' });

    expect(getAgentStatusBadge('Review Agent').textContent).toBe('Idle');
    expect(screen.getByText('No execution is available for this agent.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Seed Task' }));

    expect(getAgentStatusBadge('Review Agent').textContent).toBe('Queued');

    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }));

    expect(getAgentStatusBadge('Review Agent').textContent).toBe('Running');
    expect(screen.queryByText('No execution is available for this agent.')).toBeNull();
    expect(within(getCard('Current Incident')).getByRole('link', { name: 'INC-002' })).toBeTruthy();
    expect(getStep('Root cause analysis').textContent).toContain('Completed');
    expect(getStep('Generate proposed fix').textContent).toContain('In progress');
    expect(getStep('Run tests').textContent).toContain('Pending');
    expect(screen.getByText('src/routes/users.ts')).toBeTruthy();
  });

  it('approves the awaiting task from the Human Review panel', () => {
    renderWorkspace('AG-002');

    const review = getCard('Human Review');

    expect(within(review).getByText('TASK-002 · INC-003')).toBeTruthy();
    expect(within(review).getByText('Pending')).toBeTruthy();
    expect(getStep('Human approval').textContent).toContain('In progress');

    fireEvent.click(within(review).getByRole('button', { name: 'Approve' }));

    expect(within(getCard('Assigned Tasks (1)')).getByText('Completed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(getCard('Human Review')).getByText('Decision: Approved')).toBeTruthy();
    expect(getStep('Human approval').textContent).toContain('Completed');
    expect(getStep('Human approval').textContent).toContain('A reviewer approved the fix.');
    expect(getAgentStatusBadge('Fix Agent').textContent).toBe('Idle');
  });

  it('rejects the awaiting task from the Human Review panel', () => {
    renderWorkspace('AG-002');

    fireEvent.click(within(getCard('Human Review')).getByRole('button', { name: 'Reject' }));

    expect(within(getCard('Assigned Tasks (1)')).getByText('Failed')).toBeTruthy();
    expect(within(getCard('Human Review')).getByText('Decision: Rejected')).toBeTruthy();
    expect(getStep('Human approval').textContent).toContain('Failed');
  });

  it('reflects approvals made from the task card in the Human Review panel', () => {
    renderWorkspace('AG-002');

    fireEvent.click(within(getCard('Assigned Tasks (1)')).getByRole('button', { name: 'Approve' }));

    expect(within(getCard('Human Review')).getByText('Decision: Approved')).toBeTruthy();
  });

  it("shows execution data for the agent's own incident", () => {
    renderWorkspace('AG-002');

    expect(screen.getByText('src/workers/task.ts')).toBeTruthy();
    expect(screen.queryByText('src/db/connection.ts')).toBeNull();
    expect(screen.getByText(/this\.emit\("result", job\.payload\)/)).toBeTruthy();
  });

  it('does not show finished tests or a diff while the task is running', () => {
    renderWorkspace('AG-001');

    expect(getStep('Run tests').textContent).toContain('Pending');
    expect(screen.getByText('src/db/connection.ts')).toBeTruthy();
    expect(screen.getByText('The agent has not proposed a change yet.')).toBeTruthy();
    expect(
      within(getCard('Human Review')).getByText('No proposed changes are awaiting review.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Execution Logs' }));

    expect(screen.getByText(/Generating proposed patch/)).toBeTruthy();
    expect(screen.queryByText(/Tests completed/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Test Results' }));

    expect(screen.getByText('Tests have not run yet.')).toBeTruthy();
  });

  it('shows an explicit empty state for incidents without execution data', () => {
    renderWorkspace('AG-004', { agentId: 'AG-004', incidentId: 'INC-005' });

    fireEvent.click(screen.getByRole('button', { name: 'Seed Task' }));

    expect(getExecutionByIncident('INC-005')).toBeUndefined();
    expect(screen.getByText('No execution data yet for INC-005.')).toBeTruthy();
  });

  it('derives the validation summary from the incident test results', () => {
    renderWorkspace('AG-001');

    fireEvent.click(screen.getByRole('button', { name: 'Mark Awaiting Approval' }));

    expect(
      within(getCard('Human Review')).getByText('3 tests passed, 1 test failed.'),
    ).toBeTruthy();

    cleanup();
    renderWorkspace('AG-002');

    expect(
      within(getCard('Human Review')).getByText('3 tests passed, 0 tests failed.'),
    ).toBeTruthy();

    cleanup();
    renderWorkspace('AG-003', { agentId: 'AG-003', incidentId: 'INC-004' });

    fireEvent.click(screen.getByRole('button', { name: 'Seed Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start Task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark Awaiting Approval' }));

    expect(within(getCard('Human Review')).getByText('1 test passed, 1 test failed.')).toBeTruthy();
  });
});
