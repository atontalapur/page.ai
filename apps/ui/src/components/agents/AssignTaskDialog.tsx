import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '@page/design-system/components/ui/button';
import { Input } from '@page/design-system/components/ui/input';
import { mockAgents } from '../../data/mockAgents';
import { mockIncidents } from '../../data/mockIncidents';
import { type TaskPriority } from '../../data/mockTasks';
import { useTasks } from '../../context/TaskContext';

interface AssignTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function AssignTaskDialog({ open, onClose }: AssignTaskDialogProps) {
  const { createTask } = useTasks();

  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [agentId, setAgentId] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('Medium');

  if (!open) return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!title.trim() || !instructions.trim() || !agentId) {
      return;
    }

    createTask({
      title: title.trim(),
      instructions: instructions.trim(),
      agentId,
      incidentId: incidentId || null,
      priority,
    });

    setTitle('');
    setInstructions('');
    setAgentId('');
    setIncidentId('');
    setPriority('Medium');
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-task-title"
        className="w-full max-w-lg rounded-lg border bg-background p-6 shadow-lg"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 id="assign-task-title" className="text-xl font-semibold">
            Assign New Task
          </h2>
          <button type="button" onClick={onClose} aria-label="Close dialog">
            <X className="size-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="task-title" className="text-sm font-medium">
              Task Title
            </label>
            <Input
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Investigate API latency"
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="task-instructions" className="text-sm font-medium">
              Instructions
            </label>
            <textarea
              id="task-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Describe what the agent should investigate..."
              className="min-h-24 w-full rounded-md border bg-background p-3 text-sm"
              required
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="task-agent" className="text-sm font-medium">
              Assign Agent
            </label>
            <select
              id="task-agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              required
            >
              <option value="">Select an agent</option>
              {mockAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="task-incident" className="text-sm font-medium">
              Related Incident (Optional)
            </label>
            <select
              id="task-incident"
              value={incidentId}
              onChange={(event) => setIncidentId(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">No incident</option>
              {mockIncidents.map((incident) => (
                <option key={incident.id} value={incident.id}>
                  {incident.id} — {incident.title}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label htmlFor="task-priority" className="text-sm font-medium">
              Priority
            </label>
            <select
              id="task-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Assign Task</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
