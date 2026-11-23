// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import AgentWorkspacePage from './AgentWorkspacePage';
import { TaskProvider } from '../context/TaskContext';
import { mockAgents } from '../data/mockAgents';

afterEach(() => {
  cleanup();
});

function renderWorkspace(agentId: string) {
  return render(
    <MemoryRouter initialEntries={[`/agents/${agentId}`]}>
      <TaskProvider>
        <Routes>
          <Route path="/agents/:id" element={<AgentWorkspacePage />} />
        </Routes>
      </TaskProvider>
    </MemoryRouter>,
  );
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
});
