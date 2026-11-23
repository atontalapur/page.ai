
// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';

import AssignTaskDialog from '../../components/agents/AssignTaskDialog';
import { TaskProvider, useTasks } from '../../context/TaskContext';


afterEach(() => {
  cleanup();
});

// Test component that uses the real TaskContext
function TaskAssignmentTest() {
  const { tasks } = useTasks();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
      >
        Open Assignment
      </button>

      <AssignTaskDialog
        open={open}
        onClose={() => setOpen(false)}
      />

      <div data-testid="task-list">
        {tasks.map((task) => (
          <div key={task.id} data-testid="task-item">
            <span>{task.title}</span>
            <span>{task.instructions}</span>
            <span>{task.agentId}</span>
            <span>{task.incidentId ?? 'No incident'}</span>
            <span>{task.priority}</span>
            <span>{task.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderTaskAssignment() {
  return render(
    <TaskProvider>
      <TaskAssignmentTest />
    </TaskProvider>
  );
}

describe('Task Assignment Integration', () => {
  it('opens the assignment dialog', () => {
    renderTaskAssignment();

    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Assignment' })
    );

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Assign New Task')).toBeTruthy();
  });

  it('creates a queued task with the selected agent and incident', () => {
    renderTaskAssignment();

    const initialTaskCount =
      screen.getAllByTestId('task-item').length;

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Assignment' })
    );

    const dialog = screen.getByRole('dialog');

    fireEvent.change(
      within(dialog).getByRole('textbox', {
        name: 'Task Title',
      }),
      {
        target: { value: 'Investigate API latency' },
      }
    );

    fireEvent.change(
      within(dialog).getByRole('textbox', {
        name: 'Instructions',
      }),
      {
        target: { value: 'Analyze slow API responses' },
      }
    );

    fireEvent.change(
      within(dialog).getByRole('combobox', {
        name: 'Assign Agent',
      }),
      {
        target: { value: 'AG-003' },
      }
    );

    fireEvent.change(
      within(dialog).getByRole('combobox', {
        name: /Related Incident/i,
      }),
      {
        target: { value: 'INC-002' },
      }
    );

    fireEvent.change(
      within(dialog).getByRole('combobox', {
        name: 'Priority',
      }),
      {
        target: { value: 'High' },
      }
    );

    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'Assign Task',
      })
    );

    // The dialog should close after submission
    expect(screen.queryByRole('dialog')).toBeNull();

    // A new task should be added to shared state
    const taskItems = screen.getAllByTestId('task-item');

    expect(taskItems).toHaveLength(initialTaskCount + 1);

    // Find the newly created task
    const createdTask = taskItems.find((item) =>
      item.textContent?.includes('Investigate API latency')
    );

    expect(createdTask).toBeDefined();

    const task = within(createdTask!);

    expect(
      task.getByText('Investigate API latency')
    ).toBeTruthy();

    expect(
      task.getByText('Analyze slow API responses')
    ).toBeTruthy();

    expect(task.getByText('AG-003')).toBeTruthy();
    expect(task.getByText('INC-002')).toBeTruthy();
    expect(task.getByText('High')).toBeTruthy();
    expect(task.getByText('Queued')).toBeTruthy();
  });

  it('does not create a task when the user cancels', () => {
    renderTaskAssignment();

    const initialTaskCount =
      screen.getAllByTestId('task-item').length;

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Assignment' })
    );

    fireEvent.change(
      screen.getByRole('textbox', {
        name: 'Task Title',
      }),
      {
        target: { value: 'Cancelled Task' },
      }
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel' })
    );

    expect(screen.queryByRole('dialog')).toBeNull();

    expect(screen.getAllByTestId('task-item')).toHaveLength(
      initialTaskCount
    );

    expect(
      screen.queryByText('Cancelled Task')
    ).toBeNull();
  });

  it('creates a task without an incident', () => {
    renderTaskAssignment();

    fireEvent.click(
      screen.getByRole('button', { name: 'Open Assignment' })
    );

    fireEvent.change(
      screen.getByRole('textbox', {
        name: 'Task Title',
      }),
      {
        target: { value: 'Review system logs' },
      }
    );

    fireEvent.change(
      screen.getByRole('textbox', {
        name: 'Instructions',
      }),
      {
        target: { value: 'Check logs for errors' },
      }
    );

    fireEvent.change(
      screen.getByRole('combobox', {
        name: 'Assign Agent',
      }),
      {
        target: { value: 'AG-001' },
      }
    );

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Assign Task',
      })
    );

    const createdTask = screen
      .getAllByTestId('task-item')
      .find((item) =>
        item.textContent?.includes('Review system logs')
      );

    expect(createdTask).toBeDefined();

    const task = within(createdTask!);

    expect(task.getByText('AG-001')).toBeTruthy();
    expect(task.getByText('No incident')).toBeTruthy();
    expect(task.getByText('Medium')).toBeTruthy();
    expect(task.getByText('Queued')).toBeTruthy();
  });
});
