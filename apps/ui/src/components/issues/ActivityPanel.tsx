import { useEffect, useState } from 'react';
import type { Issue, IssueEventRecord } from '@page/contracts';

import { useIssues } from '../../context/IssuesContext';
import { classLabel, severityLabel } from '../../lib/issueLabels';

type Tone = 'plain' | 'accent' | 'warn' | 'good' | 'bad';

const dot: Record<Tone, string> = {
  plain: 'bg-muted-foreground/40',
  accent: 'bg-primary',
  warn: 'bg-amber-500',
  good: 'bg-green-600',
  bad: 'bg-red-600',
};

/** What an applied event did, in the words a reviewer would use. */
export function describeEvent(record: IssueEventRecord): {
  what: string;
  detail?: string;
  tone: Tone;
} {
  const { event, currentTier } = record;
  const tier = currentTier === null ? '' : `Tier ${currentTier}`;
  switch (event.type) {
    case 'triage':
      return {
        what: 'Triaged',
        detail: `${classLabel(event.class)}, ${severityLabel(event.severity)}`,
        tone: 'plain',
      };
    case 'start_fix':
      return { what: `${tier} fix started`, tone: 'accent' };
    case 'patch_ready':
      return { what: 'Patch ready', detail: 'waiting for review', tone: 'warn' };
    case 'ops_fixed':
      return { what: 'Fixed on the live app', detail: 'through the ops tools', tone: 'good' };
    case 'escalate':
      return { what: `Escalated to ${tier}`, detail: event.reason, tone: 'warn' };
    case 'fail':
      return { what: 'Failed', detail: event.reason, tone: 'bad' };
    case 'approve':
      return { what: 'Approved', tone: 'good' };
    case 'reject':
      return { what: `Rejected, sent to ${tier}`, detail: event.reason, tone: 'warn' };
    case 'kill':
      return { what: 'Killed', tone: 'bad' };
  }
}

const clock = (at: string) =>
  new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

/** The issue's history: when it was reported, then each event applied to it. */
export default function ActivityPanel({ issue }: { issue: Issue }) {
  const { fetchEvents } = useIssues();
  const [events, setEvents] = useState<IssueEventRecord[] | undefined>();

  useEffect(() => {
    let cancelled = false;
    void fetchEvents(issue.id).then((loaded) => {
      if (!cancelled && loaded) setEvents(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchEvents, issue.id, issue.updatedAt]);

  const rows = [
    {
      key: 'reported',
      at: issue.createdAt,
      what: 'Error reported',
      detail: undefined,
      tone: 'plain' as Tone,
    },
    ...(events ?? []).map((record) => ({
      key: record.id,
      at: record.createdAt,
      ...describeEvent(record),
    })),
  ];
  return (
    <ol className="space-y-3" aria-label="Activity">
      {rows.map((row) => (
        <li
          key={row.key}
          className="grid grid-cols-[4.25rem_0.75rem_minmax(0,1fr)] items-start gap-2"
        >
          <time
            dateTime={row.at}
            className="font-mono text-xs leading-5 tabular-nums text-muted-foreground"
          >
            {clock(row.at)}
          </time>
          <span className={`mt-1.5 size-2 rounded-full ${dot[row.tone]}`} aria-hidden="true" />
          <div className="min-w-0 text-sm leading-5">
            {row.what}
            {row.detail && (
              <p className="break-words text-xs text-muted-foreground">{row.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
