import { Fragment, useEffect, useState } from 'react';
import type { Issue, IssueEventRecord, IssueRun, Step } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';

import { useIssues } from '../../context/IssuesContext';
import { isFinished } from '../../live/runs';
import { useIssueRuns } from '../../live/useLiveRuns';
import { runStatusLabels, shortId } from '../../lib/issueLabels';
import { chatsAfterSteps } from '../../lib/runChat';
import {
  clockTime,
  commandLabel,
  editOf,
  formatDuration,
  outputNotes,
  runFigures,
  shortPath,
  stepResult,
  type StepTone,
} from '../../lib/runSteps';
import { runStatusStyles } from '../../lib/statusStyles';
import AgentText from './AgentText';
import LiveTail from './LiveTail';
import { Terminal, ToolCallCard } from './ToolCall';
import { EditView, PatchView, type DiffStyle } from './CodeDiff';
import { AskAgent, ChatItem } from './RunChat';
import { ChatScroller, Enter } from './threadMotion';

// Reasoning longer than this is cut to its opening lines until the reader asks for it.
const LONG_THOUGHT_CHARS = 360;

const toneText: Record<StepTone | 'muted', string> = {
  ok: 'text-green-11',
  bad: 'text-red-11',
  refused: 'text-amber-11',
  running: 'text-violet-11',
  muted: 'text-muted-foreground',
};

// What a model copied from the format-error prompt's example, in thoughts stored before the
// agent learned to drop it.
const EXAMPLE_TAGS = /<\/?response_example>\s*(?:THOUGHT:\s*)?/gi;

function Thought({ text: raw }: { text: string }) {
  const text = raw.replace(EXAMPLE_TAGS, '').trim();
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_THOUGHT_CHARS;
  const clamped = long && !open;
  return (
    <div className="space-y-1">
      <AgentText
        text={text}
        className={`max-w-prose space-y-2 text-sm leading-relaxed ${
          clamped
            ? 'max-h-32 overflow-hidden [mask-image:linear-gradient(#000_60%,transparent)]'
            : ''
        }`}
      />
      {long && (
        <button
          type="button"
          className="text-xs font-medium text-primary hover:underline"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show all of it'}
        </button>
      )}
    </div>
  );
}

function StepItem({ step, running }: { step: Step; running: boolean }) {
  const { label, tone } = stepResult(step, running);
  const edit = editOf(step);
  const named = commandLabel(step.input);
  return (
    <Enter item>
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
        <span className="pt-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {step.seq}
        </span>
        <div className="min-w-0 space-y-2">
        {step.thought && <Thought text={step.thought} />}
        {edit ? (
          <div className="overflow-hidden rounded-md border">
            <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-1 text-xs">
              <span className="truncate font-mono">{shortPath(edit.path)}</span>
              <span className={`shrink-0 font-medium ${toneText[tone]}`}>Edit · {label}</span>
            </div>
            <EditView {...edit} />
          </div>
        ) : step.kind === 'host_tool' ? (
          <ToolCallCard step={step} label={label} toneClass={toneText[tone]} />
        ) : (
          <Terminal
            command={named ? `${named.verb} ${named.target}` : step.input}
            output={step.allowed ? step.outputTrimmed : ''}
            label={label}
            toneClass={toneText[tone]}
          />
        )}
          {outputNotes(step).map((note) => (
            <p key={note.text} className={`text-xs ${toneText[note.tone]}`}>
              {note.text}
            </p>
          ))}
        </div>
      </div>
    </Enter>
  );
}

function PatchCard({ diff }: { diff: string }) {
  const [style, setStyle] = useState<DiffStyle>('unified');
  const lines = diff.split('\n');
  const file = lines.find((l) => l.startsWith('+++ '))?.replace(/^\+\+\+ b\//, '') ?? '';
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          Patch · <span className="font-mono">{shortPath(file)}</span>{' '}
          <span className="text-green-11">+{added}</span>{' '}
          <span className="text-red-11">−{removed}</span>
        </p>
        <div className="inline-flex gap-1" role="group" aria-label="Diff layout">
          {(['unified', 'split'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={style === option}
              onClick={() => setStyle(option)}
              className={`px-2 py-0.5 text-xs capitalize ${
                style === option ? 'font-medium text-foreground' : 'text-muted-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <PatchView patch={diff} diffStyle={style} />
      </div>
    </div>
  );
}

/** A one-line marker in the thread: a tier hand-off, not a card. */
function Marker({ title, detail }: { title: string; detail?: string }) {
  return (
    <Enter>
      <p className="flex items-baseline gap-3 text-xs text-muted-foreground" role="status">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span className="max-w-[36rem] text-center">
          <span className="font-medium text-foreground">{title}</span>
          {detail && <span className="mt-0.5 block">{detail}</span>}
        </span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </p>
    </Enter>
  );
}

function figureLine(run: IssueRun): string {
  const figures = runFigures(run);
  const time =
    figures.durationMs === null
      ? run.status === 'running'
        ? 'in progress'
        : null
      : formatDuration(figures.durationMs);
  const files = `${figures.files} ${figures.files === 1 ? 'file' : 'files'}`;
  return [
    time,
    `${figures.steps} ${figures.steps === 1 ? 'step' : 'steps'}`,
    `${figures.edits} ${figures.edits === 1 ? 'edit' : 'edits'} in ${files}`,
    figures.refused > 0 ? `${figures.refused} refused` : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

/**
 * One tier in the thread: its heading, steps and the messages that followed them, in order.
 * `handoff` is the escalation reason shown after a tier that handed the fix up.
 */
export function RunReview({ run, handoff }: { run: IssueRun; handoff?: string }) {
  const running = run.status === 'running';
  const last = run.steps.at(-1);
  const chatsAfter = chatsAfterSteps(run.steps, run.chats);
  const before = chatsAfter.get(-1);
  return (
    <section aria-label={`Tier ${run.tier}`} className="space-y-4">
      <div className="space-y-1">
        <RunHeading run={run} />
        <p className="text-xs text-muted-foreground">{figureLine(run)}</p>
      </div>

      {run.prUrl && (
        <a
          href={run.prUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium underline"
        >
          Open the pull request
        </a>
      )}
      {run.diff && <PatchCard diff={run.diff} />}

      <div role="list" className="min-w-0 space-y-4" aria-label={`Tier ${run.tier} steps`}>
        {before?.map((chat) => (
          <ChatItem key={chat.id} chat={chat} />
        ))}
        {run.steps.map((step) => (
          <Fragment key={step.seq}>
            <StepItem step={step} running={running && step === last} />
            {chatsAfter.get(step.seq)?.map((chat) => (
              <ChatItem key={chat.id} chat={chat} />
            ))}
          </Fragment>
        ))}
      </div>
      {running && <LiveTail runId={run.id} />}
      {handoff !== undefined && (
        <Marker title="Escalated to the next tier" detail={handoff === '' ? undefined : handoff} />
      )}
    </section>
  );
}

/** The reason a run handed the fix up, when the issue's events recorded one. */
function handoffReason(run: IssueRun, events: readonly IssueEventRecord[]): string | undefined {
  if (run.status !== 'escalated') return undefined;
  const found = events.find(
    (record) => record.event.type === 'escalate' && record.event.runId === run.id,
  );
  return found && found.event.type === 'escalate' ? found.event.reason : '';
}

/** A run's tier, status, short id and start time, on one line. */
export function RunHeading({
  run,
}: {
  run: Pick<IssueRun, 'id' | 'tier' | 'status' | 'startedAt'>;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-semibold">Tier {run.tier}</span>
      <Badge variant="outline" className={runStatusStyles[run.status]}>
        {runStatusLabels[run.status]}
      </Badge>
      <span className="font-mono text-xs text-muted-foreground">{shortId(run.id)}</span>
      {run.startedAt && (
        <span className="text-xs text-muted-foreground">started {clockTime(run.startedAt)}</span>
      )}
    </span>
  );
}

function useHandoffs(issueId: string, key: string): IssueEventRecord[] {
  const { fetchEvents } = useIssues();
  const [events, setEvents] = useState<IssueEventRecord[]>([]);
  useEffect(() => {
    let live = true;
    void fetchEvents(issueId).then((loaded) => {
      if (live && loaded) setEvents(loaded);
    });
    return () => {
      live = false;
    };
  }, [fetchEvents, issueId, key]);
  return events;
}

/**
 * The agent's runs on `issue`, oldest first, as one thread. Tiers, escalations and messages
 * sit in that order. Steps arrive as they happen, and the runs load again whenever the issue
 * changes and after a reconnect. The newest run can be asked while it is in progress, and
 * keeps the box, shut, once it has ended if anyone talked to it.
 */
export default function RunsPanel({ issue }: { issue: Issue }) {
  const { runs, failed } = useIssueRuns(issue.id, issue.updatedAt);
  const events = useHandoffs(issue.id, issue.updatedAt);

  if (runs === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {failed ? 'Could not load the runs.' : 'Loading runs...'}
      </p>
    );
  }
  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No agent has worked on this incident yet.</p>
    );
  }
  const latest = runs.at(-1)!;
  const ask = !isFinished(latest) || latest.chats.length > 0;
  return (
    <div className="space-y-4">
      <ChatScroller label="Agent thread">
        {runs.map((run) => (
          <RunReview key={run.id} run={run} handoff={handoffReason(run, events)} />
        ))}
      </ChatScroller>
      {/* Keyed by run, so a draft or an error never carries over to the next one. */}
      {ask && <AskAgent key={latest.id} run={latest} />}
    </div>
  );
}
