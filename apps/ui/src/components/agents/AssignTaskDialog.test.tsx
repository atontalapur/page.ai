// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { TaskProvider, useTasks } from '../../context/TaskContext';
import AssignTaskDialog from './AssignTaskDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(open = true, onClose = vi.fn()) {
  render(
    <TaskProvider>
      <AssignTaskDialog open={open} onClose={onClose} />
      <TaskCount />
    </TaskProvider>,
  );

  return { onClose };
}

function TaskCount() {
  const { tasks } = useTasks();

  return <output data-testid="task-count">{tasks.length}</output>;
}

describe('AssignTaskDialog', () => {
  it('does not render when closed', () => {
    renderDialog(false);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the assignment form when opened', () => {
    renderDialog();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Assign New Task')).toBeTruthy();

    expect(screen.getByRole('textbox', { name: 'Task Title' })).toBeTruthy();

    expect(screen.getByRole('textbox', { name: 'Instructions' })).toBeTruthy();

    expect(screen.getByRole('combobox', { name: 'Assign Agent' })).toBeTruthy();
  });

  it('allows entering a task title', () => {
    renderDialog();

    const titleInput = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Task Title',
    });

    fireEvent.change(titleInput, {
      target: { value: 'Investigate API latency' },
    });

    expect(titleInput.value).toBe('Investigate API latency');
  });

  it('allows entering instructions', () => {
    renderDialog();

    const instructionsInput = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions',
    });

    fireEvent.change(instructionsInput, {
      target: { value: 'Analyze slow API responses' },
    });

    expect(instructionsInput.value).toBe('Analyze slow API responses');
  });

  it('allows selecting an agent', () => {
    renderDialog();

    const agentSelect = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Assign Agent',
    });

    fireEvent.change(agentSelect, {
      target: { value: 'AG-003' },
    });

    expect(agentSelect.value).toBe('AG-003');
  });

  it('allows selecting a related incident', () => {
    renderDialog();

    const incidentSelect = screen.getByRole<HTMLSelectElement>('combobox', {
      name: /Related Incident/i,
    });

    fireEvent.change(incidentSelect, {
      target: { value: 'INC-002' },
    });

    expect(incidentSelect.value).toBe('INC-002');
  });

  it('closes when Cancel is clicked', () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes when the X button is clicked', () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('moves focus into the dialog on open, starting at the title field', async () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');

    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(dialog).getByRole('textbox', { name: 'Task Title' }),
      );
    });
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    const dialog = screen.getByRole('dialog');
    const titleInput = within(dialog).getByRole('textbox', { name: 'Task Title' });

    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput);
    });

    fireEvent.keyDown(titleInput, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('creates the task and closes on submit', () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    const initialCount = Number(screen.getByTestId('task-count').textContent);
    const dialog = within(screen.getByRole('dialog'));

    fireEvent.change(dialog.getByRole('textbox', { name: 'Task Title' }), {
      target: { value: 'Investigate API latency' },
    });
    fireEvent.change(dialog.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Analyze slow API responses' },
    });
    fireEvent.change(dialog.getByRole('combobox', { name: 'Assign Agent' }), {
      target: { value: 'AG-003' },
    });

    fireEvent.click(dialog.getByRole('button', { name: 'Assign Task' }));

    expect(screen.getByTestId('task-count').textContent).toBe(String(initialCount + 1));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not create a task when required fields are empty', () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    const initialCount = screen.getByTestId('task-count').textContent;

    const submitButton = within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Assign Task',
    });

    fireEvent.submit(submitButton.closest('form')!);

    expect(screen.getByTestId('task-count').textContent).toBe(initialCount);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked', async () => {
    const onClose = vi.fn();

    renderDialog(true, onClose);

    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Task Title' }));
    });

    const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;

    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalled();
  });

  it('returns focus to the trigger when closed', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);

      return (
        <TaskProvider>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <AssignTaskDialog open={open} onClose={() => setOpen(false)} />
        </TaskProvider>
      );
    }

    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Open' });

    trigger.focus();
    fireEvent.click(trigger);

    const titleInput = within(screen.getByRole('dialog')).getByRole('textbox', {
      name: 'Task Title',
    });

    await waitFor(() => {
      expect(document.activeElement).toBe(titleInput);
    });

    fireEvent.keyDown(titleInput, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
  });
});
