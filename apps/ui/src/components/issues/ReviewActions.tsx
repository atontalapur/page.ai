import { useState, type FormEvent } from 'react';
import { MAX_REASON_CHARS, type Issue, type IssueEvent } from '@page/contracts';
import { Button } from '@page/design-system/components/ui/button';
import { Textarea } from '@page/design-system/components/ui/textarea';

import { useIssues } from '../../context/IssuesContext';

/** The statuses where a fix waits on a human: a patch to review, or the PR opened for it. */
export function awaitsReview(issue: Issue): boolean {
  return issue.status === 'awaiting_approval' || issue.status === 'pr_open';
}

/**
 * Approve or reject the fix an issue is waiting on. Approving resolves the incident; it
 * doesn't apply or merge anything. Rejecting sends the issue up a tier, or to failed past
 * Tier 3, and hands the reason to the next run.
 */
export default function ReviewActions({ issue }: { issue: Issue }) {
  const { applyEvent } = useIssues();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function send(event: IssueEvent) {
    setPending(true);
    setError(undefined);
    try {
      await applyEvent(issue.id, event);
      setRejecting(false);
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  function reject(e: FormEvent) {
    e.preventDefault();
    const trimmed = reason.trim();
    if (trimmed !== '') void send({ type: 'reject', reason: trimmed });
  }

  const next = issue.currentTier === 3 ? 'marks it failed' : 'sends it to the next tier';
  return (
    <section
      aria-label="Review"
      className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950"
    >
      <div className="space-y-1">
        <h3 className="font-semibold">This fix is waiting for review</h3>
        <p className="text-sm text-muted-foreground">
          Approving resolves the incident; it doesn&apos;t apply or merge the patch. Rejecting{' '}
          {next} with your reason.
        </p>
      </div>

      {rejecting ? (
        <form onSubmit={reject} className="space-y-2">
          <label htmlFor="reject-reason" className="text-sm font-medium">
            Why is the fix wrong?
          </label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={MAX_REASON_CHARS}
            placeholder="The next run gets this as its starting note."
            disabled={pending}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="destructive" disabled={pending || reason.trim() === ''}>
              {pending ? 'Rejecting...' : 'Reject fix'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setRejecting(false);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => void send({ type: 'approve' })}>
            {pending ? 'Approving...' : 'Approve'}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
