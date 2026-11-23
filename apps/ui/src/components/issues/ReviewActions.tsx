import { useState, type FormEvent } from 'react';
import { MAX_REASON_CHARS, type Issue, type IssueEvent } from '@page/contracts';
import { Button, buttonVariants } from '@page/design-system/components/ui/button';
import { Textarea } from '@page/design-system/components/ui/textarea';

import { SquareShareLineIcon } from '@solar-icons/react/bold-duotone';

import { useIssues } from '../../context/IssuesContext';
import { useIssueRuns } from '../../live/useLiveRuns';

/** The statuses where a fix waits on a human: a patch to review, or the PR opened for it. */
export function awaitsReview(issue: Issue): boolean {
  return issue.status === 'awaiting_approval' || issue.status === 'pr_open';
}

/**
 * A fix with a PR is reviewed on GitHub: merging approves it, and requesting changes or
 * closing it rejects it, with the review handed to the next tier. Without a PR, approve or
 * reject it here.
 */
export default function ReviewActions({ issue }: { issue: Issue }) {
  const { runs } = useIssueRuns(issue.id, issue.updatedAt);
  const prUrl = runs?.at(-1)?.prUrl ?? null;
  if (prUrl) return <ReviewOnGitHub prUrl={prUrl} />;
  return <DashboardReview issue={issue} />;
}

function ReviewOnGitHub({ prUrl }: { prUrl: string }) {
  return (
    <section aria-label="Review" className="space-y-3 rounded-md bg-amber-a2 p-4">
      <div className="space-y-1">
        <h3 className="font-semibold">This fix is waiting for review on GitHub</h3>
        <p className="text-sm text-muted-foreground">
          Approving or merging the PR approves the fix and resolves the incident. Requesting changes
          or closing it rejects the fix: the next tier starts from your review and its comments. On
          a PR opened with your own token, comment <code>/approve</code> or <code>/reject</code>{' '}
          instead.
        </p>
      </div>
      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        className={buttonVariants({ variant: 'default' })}
      >
        <SquareShareLineIcon className="size-4" aria-hidden />
        Review on GitHub
      </a>
    </section>
  );
}

/**
 * Approve or reject the fix an issue is waiting on. Approving resolves the incident; it
 * doesn't apply or merge anything. Rejecting sends the issue up a tier, or to failed past
 * Tier 3, and hands the reason to the next run.
 */
function DashboardReview({ issue }: { issue: Issue }) {
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
    <section aria-label="Review" className="space-y-3 rounded-md bg-amber-a2 p-4">
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
        <p role="alert" className="text-sm text-red-11">
          {error}
        </p>
      )}
    </section>
  );
}
