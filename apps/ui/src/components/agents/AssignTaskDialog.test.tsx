// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { TaskProvider } from '../../context/TaskContext';
import AssignTaskDialog from './AssignTaskDialog';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog(open = true, onClose = vi.fn()) {
  render(
    <TaskProvider>
      <AssignTaskDialog open={open} onClose={onClose} />
    </TaskProvider>,
  );

  return { onClose };
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

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
