import { useState } from 'react';
import { StopCircleIcon } from '@solar-icons/react/bold-duotone';
import { Button } from '@page/design-system/components/ui/button';

import { useIssues } from '../../context/IssuesContext';

/**
 * Stops the run working an incident: the `kill` event, which cancels its job, stops the
 * agent's sandbox, and ends the incident as killed. It asks once before it does.
 */
export default function StopRunButton({ issueId }: { issueId: string }) {
  const { applyEvent } = useIssues();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function stop() {
    setPending(true);
    setError(undefined);
    try {
      await applyEvent(issueId, { type: 'kill' });
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
        <StopCircleIcon className="size-4" />
        Stop run
      </Button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Stop this run">
      <span className="text-sm text-muted-foreground">
        Stop the run? The incident ends as killed.
      </span>
      <Button variant="destructive" size="sm" disabled={pending} onClick={() => void stop()}>
        {pending ? 'Stopping...' : 'Stop run'}
      </Button>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
        Keep running
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-red-11">
          {error}
        </p>
      )}
    </div>
  );
}
