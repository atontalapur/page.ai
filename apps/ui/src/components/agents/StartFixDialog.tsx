import { useRef, useState, type FormEvent } from 'react';
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

import { useIssues } from '../../context/IssuesContext';
import { classLabel, severityLabel, shortId } from '../../lib/issueLabels';

interface StartFixDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Starts a Tier 1 fix on a triaged incident, the `start_fix` event. The orchestrator queues a
 * fix job and the first free daemon claims it: there is no picking which one.
 */
export default function StartFixDialog({ open, onClose }: StartFixDialogProps) {
  const { issues, applyEvent } = useIssues();
  const selectRef = useRef<HTMLSelectElement>(null);
  const [issueId, setIssueId] = useState('');
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
      await applyEvent(issueId, { type: 'start_fix' });
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
            Queues a Tier 1 fix for a triaged incident. The first free agent claims it; you
            can&apos;t pick which one.
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
