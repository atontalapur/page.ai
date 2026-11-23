import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@page/design-system/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@page/design-system/components/ui/dialog';
import { Input } from '@page/design-system/components/ui/input';
import { Label } from '@page/design-system/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@page/design-system/components/ui/native-select';
import { Textarea } from '@page/design-system/components/ui/textarea';
import { mockAgents } from '../../data/mockAgents';
import { mockIncidents } from '../../data/mockIncidents';
import { type TaskPriority } from '../../data/mockTasks';
import { useTasks } from '../../context/TaskContext';

interface AssignTaskDialogProps {
  open: boolean;
  onClose: () => void;
}

const priorities: TaskPriority[] = ['Low', 'Medium', 'High', 'Critical'];

export default function AssignTaskDialog({ open, onClose }: AssignTaskDialogProps) {
  const { createTask } = useTasks();
  const titleInputRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [agentId, setAgentId] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('Medium');

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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent initialFocus={titleInputRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Assign New Task</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">Task Title</Label>
            <Input
              ref={titleInputRef}
              id="task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Investigate API latency"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-instructions">Instructions</Label>
            <Textarea
              id="task-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Describe what the agent should investigate..."
              className="min-h-24"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-agent">Assign Agent</Label>
            <NativeSelect
              id="task-agent"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              className="w-full"
              required
            >
              <NativeSelectOption value="">Select an agent</NativeSelectOption>
              {mockAgents.map((agent) => (
                <NativeSelectOption key={agent.id} value={agent.id}>
                  {agent.name} ({agent.id})
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-incident">Related Incident (Optional)</Label>
            <NativeSelect
              id="task-incident"
              value={incidentId}
              onChange={(event) => setIncidentId(event.target.value)}
              className="w-full"
            >
              <NativeSelectOption value="">No incident</NativeSelectOption>
              {mockIncidents.map((incident) => (
                <NativeSelectOption key={incident.id} value={incident.id}>
                  {incident.id} — {incident.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-priority">Priority</Label>
            <NativeSelect
              id="task-priority"
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
              className="w-full"
            >
              {priorities.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {level}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <DialogFooter className="pt-3">
            <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
            <Button type="submit">Assign Task</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
