import type { IssueRun, NodeRun, NodeSummary, Run, RunChat, Step } from '@page/contracts';

import { runIdOf, type RunEvent } from './source';

const FINISHED: ReadonlySet<Run['status']> = new Set([
  'succeeded',
  'escalated',
  'failed',
  'killed',
]);

/** Whether a run has ended, whatever the way. */
export const isFinished = (run: Pick<Run, 'status'>) => FINISHED.has(run.status);

/**
 * `run` with what a run event says of the run itself. A run that has ended keeps its result
 * against a late `run.started`; a step moves a queued run to running.
 */
function withRunFields<R extends Run>(run: R, event: RunEvent): R {
  switch (event.event) {
    case 'run.started': {
      if (isFinished(run)) return run;
      const { status, startedAt } = event.payload.run;
      return { ...run, status, startedAt: run.startedAt ?? startedAt };
    }
    case 'run.finished': {
      const { status, finishedAt, prUrl, confidence } = event.payload.run;
      return { ...run, status, finishedAt, prUrl, confidence };
    }
    case 'run.step': {
      if (run.status !== 'queued') return run;
      return {
        ...run,
        status: 'running',
        startedAt: run.startedAt ?? event.payload.step.createdAt,
      };
    }
    case 'run.diff':
    case 'run.chat.asked':
    case 'run.chat.reply':
      return run;
  }
}

/**
 * `chats` with `chat` in its place by id, oldest asked first. An answer is final, so a
 * pending copy that arrives late (a load that read the row before the answer) never
 * replaces it.
 */
export function withChat(chats: readonly RunChat[], chat: RunChat): RunChat[] {
  const current = chats.find((c) => c.id === chat.id);
  if (current && current.status !== 'pending' && chat.status === 'pending') return [...chats];
  return [...chats.filter((c) => c.id !== chat.id), chat].sort(
    (a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id),
  );
}

/** `steps` with `step` in its place by seq. The daemon sends a step once it is final, so it
 * replaces a copy loaded while its command was still running. */
function withStep(steps: readonly Step[], step: Step): Step[] {
  return [...steps.filter((s) => s.seq !== step.seq), step].sort((a, b) => a.seq - b.seq);
}

/**
 * An issue's runs after `event`. A run the list doesn't have is added when `run.started`
 * says it is this issue's; any other event for it is ignored, since the list is loaded again
 * when the issue changes.
 */
export function applyToIssueRuns(
  runs: readonly IssueRun[],
  event: RunEvent,
  issueId: string,
): IssueRun[] {
  const id = runIdOf(event);
  if (!runs.some((run) => run.id === id)) {
    if (event.event !== 'run.started' || event.payload.run.issueId !== issueId) return [...runs];
    return [...runs, { ...event.payload.run, diff: null, steps: [], chats: [] }];
  }
  return runs.map((run) => {
    if (run.id !== id) return run;
    const next = withRunFields(run, event);
    if (event.event === 'run.step')
      return { ...next, steps: withStep(next.steps, event.payload.step) };
    if (event.event === 'run.diff') return { ...next, diff: event.payload.diff };
    if (event.event === 'run.chat.asked' || event.event === 'run.chat.reply') {
      return { ...next, chats: withChat(next.chats, event.payload.chat) };
    }
    return next;
  });
}

/** A run as the agents page lists it, after `event`, which must be about it. */
export function applyToNodeRun(run: NodeRun, event: RunEvent): NodeRun {
  const next = withRunFields(run, event);
  if (event.event !== 'run.step') return next;
  const { step } = event.payload;
  if (next.lastStep && next.lastStep.seq > step.seq) return next;
  return { ...next, lastStep: step, stepCount: Math.max(next.stepCount, step.seq + 1) };
}

/** A daemon's list of runs after `event`. Runs it doesn't name are left as they are. */
export function applyToNodeRuns(runs: readonly NodeRun[], event: RunEvent): NodeRun[] {
  const id = runIdOf(event);
  return runs.map((run) => (run.id === id ? applyToNodeRun(run, event) : run));
}

/** A daemon after `event`: the run it holds, if the event is about one, brought up to date. */
export function applyToNode(node: NodeSummary, event: RunEvent): NodeSummary {
  const id = runIdOf(event);
  if (!node.current.some((run) => run.id === id)) return node;
  return { ...node, current: applyToNodeRuns(node.current, event) };
}
