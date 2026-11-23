import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@page/design-system/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@page/design-system/components/ui/dialog';
import { Label } from '@page/design-system/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@page/design-system/components/ui/native-select';

import { useAgents, useIssues } from '../../context/IssuesContext';
import { inProgress } from '../../lib/agents';
import { classLabel, severityLabel, shortId } from '../../lib/issueLabels';

interface StartFixDialogProps {
  open: boolean;
  onClose: () => void;
  /** The agent chosen when the dialog opens, such as the one whose page it was opened from. */
  agent?: string;
}

/** The value of the agent select for "whichever agent is free". */
const ANY_AGENT = '';

/**
 * Starts a Tier 1 fix on a triaged incident, the `start_fix` event. With an agent chosen, the
 * orchestrator queues it for that agent alone; with "Any agent", the first free one claims it.
 * Higher tiers always go to any agent.
 */
export default function StartFixDialog({ open, onClose, agent }: StartFixDialogProps) {
  const { issues, applyEvent } = useIssues();
  const { nodes } = useAgents();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [issueId, setIssueId] = useState('');
  const [node, setNode] = useState(agent ?? ANY_AGENT);
  const connected = nodes.filter((n) => n.connected);

  useEffect(() => {
    if (open) setNode(agent ?? ANY_AGENT);
  }, [open, agent]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const triaged = issues.filter((issue) => issue.status === 'triaged');

  function close() {
    setIssueId('');
    setError(undefined);
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!issueId) return;
    setPending(true);
    setError(undefined);
    try {
      await applyEvent(
        issueId,
        node === ANY_AGENT ? { type: 'start_fix' } : { type: 'start_fix', node },
      );
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent initialFocus={selectRef} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold">Start a fix</DialogTitle>
          <DialogDescription>
            Queues a Tier 1 fix for a triaged incident, on the agent you choose or the first free
            one. If the fix moves up a tier, any agent can take it.
          </DialogDescription>
        </DialogHeader>

        {triaged.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No incident is triaged and waiting for a fix.
          </p>
        ) : (
          <form id="start-fix" onSubmit={(e) => void submit(e)} className="space-y-2">
            <Label htmlFor="start-fix-incident">Incident</Label>
            <NativeSelect
              ref={selectRef}
              id="start-fix-incident"
              value={issueId}
              onChange={(e) => setIssueId(e.target.value)}
              className="w-full"
              disabled={pending}
              required
            >
              <NativeSelectOption value="">Select a triaged incident</NativeSelectOption>
              {triaged.map((issue) => (
                <NativeSelectOption key={issue.id} value={issue.id}>
                  {shortId(issue.id)} · {severityLabel(issue.severity)} · {classLabel(issue.class)}{' '}
                  · {issue.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>

            <Label htmlFor="start-fix-agent" className="pt-2">
              Agent
            </Label>
            <NativeSelect
              id="start-fix-agent"
              value={node}
              onChange={(e) => setNode(e.target.value)}
              className="w-full"
              disabled={pending}
            >
              <NativeSelectOption value={ANY_AGENT}>
                Any agent, the first one free
              </NativeSelectOption>
              {connected.map((n) => (
                <NativeSelectOption key={n.name} value={n.name}>
                  {n.name} · {inProgress(n).length > 0 ? 'busy, it waits for this one' : 'idle'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </form>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-11">
            {error}
          </p>
        )}

        <DialogFooter className="pt-3">
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="submit" form="start-fix" disabled={pending || !issueId}>
            {pending ? 'Starting...' : 'Start fix'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
