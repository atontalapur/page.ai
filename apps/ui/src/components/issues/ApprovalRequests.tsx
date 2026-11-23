import { useEffect, useId, useState, type FormEvent } from 'react';
import { ClockCircleIcon, ShieldWarningIcon } from '@solar-icons/react/linear';
import { approverNameSchema, type Approval, type Issue } from '@page/contracts';
import { Button } from '@page/design-system/components/ui/button';
import { Input } from '@page/design-system/components/ui/input';
import { Label } from '@page/design-system/components/ui/label';

import { useIssues } from '../../context/IssuesContext';
import { describeApproval } from '../../lib/approvalText';
import { formatDuration } from '../../lib/runSteps';
import type { ApprovalDecision } from '../../live/source';

/** Milliseconds until `at`, read again every second. */
function useTimeLeft(at: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  return Date.parse(at) - now;
}

/** Asks for the name the server records this tab's decisions and messages under. */
export function NameForm({
  onSave,
  hint = 'Your decision is recorded under this name.',
}: {
  onSave: (name: string) => void;
  hint?: string;
}) {
  const [name, setName] = useState('');
  const id = useId();
  const valid = approverNameSchema.safeParse(name).success;

  function save(e: FormEvent) {
    e.preventDefault();
    const parsed = approverNameSchema.safeParse(name);
    if (parsed.success) onSave(parsed.data);
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id}>Your name</Label>
        <Input
          id={id}
          value={name}
          maxLength={40}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint} Letters, digits, spaces and .&apos;_- only.
        </p>
      </div>
      <Button type="submit" variant="outline" disabled={!valid}>
        Save name
      </Button>
    </form>
  );
}

/**
 * Why the agent asks, as the model wrote it. The model read an error report anyone could have
 * shaped, so this is plain text: React escapes it, and no markdown or link in it is rendered.
 */
function Reason({ text }: { text: string }) {
  const id = useId();
  return (
    <figure aria-labelledby={id} className="space-y-1">
      <figcaption id={id} className="text-xs text-muted-foreground">
        The agent&apos;s reason, in its own words. Nothing checked it.
      </figcaption>
      <blockquote
        tabIndex={0}
        className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md border-l-2 border-violet-a6 bg-muted/50 px-3 py-2 text-sm"
      >
        {text}
      </blockquote>
    </figure>
  );
}

function Request({
  approval,
  canDecide,
  onDecide,
}: {
  approval: Approval;
  canDecide: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const [sent, setSent] = useState<ApprovalDecision | undefined>();
  const left = useTimeLeft(approval.expiresAt);
  const { title, detail } = describeApproval(approval);

  function decide(decision: ApprovalDecision) {
    setSent(decision);
    onDecide(decision);
  }

  return (
    <li className="space-y-3 rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{title}</p>
        <p className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
          <ClockCircleIcon className="size-3.5" />
          {left > 0 ? `Expires in ${formatDuration(left)}` : 'Expiring'}
        </p>
      </div>
      <p className="text-sm">{detail}</p>
      <p className="font-mono text-xs text-muted-foreground">{approval.action}</p>
      {approval.reason !== null && <Reason text={approval.reason} />}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canDecide || sent !== undefined} onClick={() => decide('approved')}>
          {sent === 'approved' ? 'Approving...' : 'Approve'}
        </Button>
        <Button
          variant="outline"
          disabled={!canDecide || sent !== undefined}
          onClick={() => decide('rejected')}
        >
          {sent === 'rejected' ? 'Rejecting...' : 'Reject'}
        </Button>
      </div>
    </li>
  );
}

/**
 * The Tier 3 requests an issue's run is waiting on: an action on the live app that runs only
 * once someone approves it. This is not the review of a finished fix (ReviewActions): the run
 * is paused mid-way, and a rejection sends the agent to try something else or escalate.
 *
 * Requests arrive on the socket and are loaded again when the page opens or reconnects. Each
 * one leaves every tab once it is decided, by anyone, or the server closes it.
 */
export default function ApprovalRequests({ issue }: { issue: Issue }) {
  const {
    pendingApprovals,
    loadApprovals,
    decideApproval,
    approverName,
    setApproverName,
    status,
    session,
    signOut,
  } = useIssues();
  const [renaming, setRenaming] = useState(false);
  const live = status === 'live';

  useEffect(() => {
    if (live) void loadApprovals(issue.id);
  }, [issue.id, live, loadApprovals]);

  const pending = pendingApprovals(issue.id);
  if (pending.length === 0) return null;
  // A personal token decides under its own name. The shared token can't decide once the
  // orchestrator has personal tokens; until then it decides under a name the tab gives.
  const signedIn = session?.token === 'personal' ? session.name : undefined;
  const sharedOnly = session?.token === 'shared' && !session.canDecide;
  const asking = signedIn === undefined && !sharedOnly && (approverName === null || renaming);
  const canDecide = live && !sharedOnly && !asking;

  return (
    <section
      aria-label="Live app actions waiting for approval"
      className="space-y-3 rounded-xl border border-violet-a6 bg-violet-a2 p-4"
    >
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 font-semibold">
          <ShieldWarningIcon className="size-5 text-violet-11" />
          The agent is asking to change the live app
        </h3>
        <p className="text-sm text-muted-foreground">
          A Tier 3 run is paused until someone decides. Approving runs this one action on the live
          app now. Rejecting tells the agent no, and it tries something else or escalates. This is
          separate from reviewing a finished fix.
        </p>
      </div>

      {signedIn !== undefined ? (
        <p className="text-xs text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{signedIn}</span>. Your
          decision is recorded under this name.
        </p>
      ) : sharedOnly ? (
        <p className="text-xs text-muted-foreground">
          This tab connected with the shared API token, which can&apos;t approve or reject.{' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={signOut}
          >
            Connect with your personal token
          </button>{' '}
          to decide.
        </p>
      ) : asking ? (
        <NameForm
          onSave={(name) => {
            setApproverName(name);
            setRenaming(false);
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          Deciding as <span className="font-medium text-foreground">{approverName}</span>.{' '}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => setRenaming(true)}
          >
            Change
          </button>
        </p>
      )}
      {!live && (
        <p role="status" className="text-xs text-muted-foreground">
          Not connected to the orchestrator, so no one can decide from this tab until it is back.
        </p>
      )}

      <ul className="space-y-3">
        {pending.map((approval) => (
          <Request
            key={approval.id}
            approval={approval}
            canDecide={canDecide}
            onDecide={(decision) => decideApproval(approval.id, decision)}
          />
        ))}
      </ul>
    </section>
  );
}
