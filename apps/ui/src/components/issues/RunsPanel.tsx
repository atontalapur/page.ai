import { Fragment, useState } from 'react';
import type { Issue, IssueRun, RunChat, Step } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';

import { isFinished } from '../../live/runs';
import { useIssueRuns } from '../../live/useLiveRuns';
import { runStatusLabels, shortId } from '../../lib/issueLabels';
import { chatsAfterSteps } from '../../lib/runChat';
import {
  PHASE_BLURBS,
  clockTime,
  commandLabel,
  editOf,
  formatDuration,
  outputNotes,
  phasesOf,
  runFigures,
  shortPath,
  stepResult,
  type StepTone,
} from '../../lib/runSteps';
import { runStatusStyles } from '../../lib/statusStyles';
import AgentText from './AgentText';
import { EditView, PatchView, type DiffStyle } from './CodeDiff';
import { AskAgent, ChatItem } from './RunChat';

// Reasoning longer than this is cut to its opening lines until the reader asks for it.
const LONG_THOUGHT_CHARS = 360;

const toneText: Record<StepTone | 'muted', string> = {
  ok: 'text-green-11',
  bad: 'text-red-11',
  refused: 'text-amber-11',
  running: 'text-violet-11',
  muted: 'text-muted-foreground',
};

function Thought({ text }: { text: string }) {
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
    <li className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
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
        ) : (
          <div className="flex min-w-0 items-center gap-3 rounded-md border bg-muted/30 px-3 py-1">
            <code className="min-w-0 flex-1 truncate font-mono text-xs" title={step.input}>
              {named ? (
                <>
                  <span className="font-medium text-primary">{named.verb}</span>{' '}
                  <span className="text-muted-foreground">{named.target}</span>
                </>
              ) : (
                <span className="text-muted-foreground">$ {step.input}</span>
              )}
            </code>
            <span className={`shrink-0 text-xs font-medium ${toneText[tone]}`}>{label}</span>
          </div>
        )}
        {outputNotes(step).map((note) => (
          <p key={note.text} className={`text-xs ${toneText[note.tone]}`}>
            {note.text}
          </p>
        ))}
        {!edit && step.allowed && step.outputTrimmed !== '' && (
          <details>
            <summary className="w-fit cursor-pointer text-xs text-muted-foreground">Output</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">
              {step.outputTrimmed}
            </pre>
          </details>
        )}
      </div>
    </li>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="space-y-0.5 bg-card px-4 py-3">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">
        {value}
        {note && <span className="ml-1 text-xs font-normal text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

function PatchCard({ diff }: { diff: string }) {
  const [style, setStyle] = useState<DiffStyle>('unified');
  const lines = diff.split('\n');
  const file = lines.find((l) => l.startsWith('+++ '))?.replace(/^\+\+\+ b\//, '') ?? '';
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 border-b py-3">
        <div className="min-w-0">
          <CardTitle className="text-sm">Patch</CardTitle>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{shortPath(file)}</span>{' '}
            <span className="text-green-11">+{added}</span>{' '}
            <span className="text-red-11">−{removed}</span>
          </p>
        </div>
        <div
          className="inline-flex overflow-hidden rounded-md border"
          role="group"
          aria-label="Diff layout"
        >
          {(['unified', 'split'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={style === option}
              onClick={() => setStyle(option)}
              className={`px-3 py-1 text-xs capitalize ${
                style === option ? 'bg-muted font-medium' : 'text-muted-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <PatchView patch={diff} diffStyle={style} />
      </CardContent>
    </Card>
  );
}

function ChatList({ chats, label }: { chats: RunChat[] | undefined; label: string }) {
  if (!chats?.length) return null;
  return (
    <ol className="min-w-0 space-y-4 px-4 py-4" aria-label={label}>
      {chats.map((chat) => (
        <ChatItem key={chat.id} chat={chat} />
      ))}
    </ol>
  );
}

/**
 * A run's figures, its PR and patch, and its steps grouped by phase, with each message people
 * sent it after the step it followed. `ask` adds the box to send the agent one.
 */
export function RunReview({ run, ask = false }: { run: IssueRun; ask?: boolean }) {
  const figures = runFigures(run);
  const running = run.status === 'running';
  const last = run.steps.at(-1);
  const chatsAfter = chatsAfterSteps(run.steps, run.chats);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Figure
          label={running ? 'Running for' : 'Time to finish'}
          value={figures.durationMs === null ? '—' : formatDuration(figures.durationMs)}
        />
        <Figure
          label="Steps"
          value={String(figures.steps)}
          note={`${figures.withThought} with reasoning`}
        />
        <Figure
          label="Edits"
          value={String(figures.edits)}
          note={`in ${figures.files} ${figures.files === 1 ? 'file' : 'files'}`}
        />
        <Figure label="Refused" value={String(figures.refused)} note="by policy" />
      </dl>

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

      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3">
          <CardTitle className="text-sm">How the agent got there</CardTitle>
          <p className="text-xs text-muted-foreground">
            {run.steps.length === 0
              ? 'No steps yet.'
              : `${run.steps.length} steps in the agent's own words, each run as an unprivileged user in the sandbox`}
          </p>
        </CardHeader>
        <CardContent className="divide-y px-0">
          <ChatList chats={chatsAfter.get(-1)} label="Messages before the first step" />
          {phasesOf(run.steps).map((group) => {
            const from = Date.parse(group.steps[0]!.createdAt);
            const to = Date.parse(group.steps.at(-1)!.createdAt);
            return (
              <section
                key={`${group.phase}-${group.steps[0]!.seq}`}
                aria-label={`${group.phase}, from step ${group.steps[0]!.seq}`}
                className="grid gap-3 px-4 py-4 md:grid-cols-[8rem_minmax(0,1fr)] md:gap-4"
              >
                <div className="space-y-0.5">
                  <h4 className="text-sm font-semibold">{group.phase}</h4>
                  <p className="text-xs text-muted-foreground">{PHASE_BLURBS[group.phase]}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    {group.steps.length} {group.steps.length === 1 ? 'step' : 'steps'} ·{' '}
                    {formatDuration(Math.max(to - from, 1000))}
                  </p>
                </div>
                <ol className="min-w-0 space-y-4" aria-label={`Tier ${run.tier} steps`}>
                  {group.steps.map((step) => (
                    <Fragment key={step.seq}>
                      <StepItem step={step} running={running && step === last} />
                      {chatsAfter.get(step.seq)?.map((chat) => (
                        <ChatItem key={chat.id} chat={chat} />
                      ))}
                    </Fragment>
                  ))}
                </ol>
              </section>
            );
          })}
        </CardContent>
        {/* Keyed by run, so a draft or an error never carries over to the next one. */}
        {ask && <AskAgent key={run.id} run={run} />}
      </Card>
    </div>
  );
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

/**
 * The agent's runs on `issue`, newest open. Steps and messages arrive as they happen, and the
 * runs are loaded again whenever the issue changes and after a reconnect. The newest run has
 * the box to ask the agent while it is in progress, and keeps it, shut, once it has ended if
 * anyone talked to it.
 */
export default function RunsPanel({ issue }: { issue: Issue }) {
  const { runs, failed } = useIssueRuns(issue.id, issue.updatedAt);

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
  const earlier = runs.slice(0, -1).reverse();
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <RunHeading run={latest} />
        <RunReview run={latest} ask={!isFinished(latest) || latest.chats.length > 0} />
      </div>
      {earlier.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground">Earlier runs</h3>
          {earlier.map((run) => (
            <details key={run.id} className="rounded-lg border p-3">
              <summary className="cursor-pointer">
                <RunHeading run={run} />
              </summary>
              <div className="mt-3">
                <RunReview run={run} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
