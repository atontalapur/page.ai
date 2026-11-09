import type { AgentRun } from '@page/agent';
import type { EscalationNote, Tier } from '@page/contracts';
import type { NodePayload } from '../link/link.ts';

export type RunFinished = NodePayload<'node.run.finished'>;

/** How a run ended, from the daemon's side. */
export type RunEnd =
  | { kind: 'agent'; run: AgentRun }
  | { kind: 'no_report' }
  | { kind: 'sandbox_failed'; message: string }
  | { kind: 'crashed'; message: string }
  | { kind: 'expired' }
  | { kind: 'killed' };

// The note keeps the last few commands, in the order they ran, each clipped.
const TRIED_LIMIT = 20;
const TRIED_CHARS = 200;
const SUMMARY_CHARS = 500;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

/**
 * The `node.run.finished` event for a run. `tried` is what the agent ran, in order, and
 * `prUrl` the PR it opened, if it got that far.
 *
 * A submitted run is a success with no confidence: nothing scores runs yet. A run that ran
 * out of budget escalates a tier (Tier 3 has nowhere to go, so it fails). A killed run is
 * `killed`, with what it had tried so far. Everything else
 * is a failure: retrying a broken model, audit log or sandbox at a higher tier won't help.
 */
export function finishedEvent(
  runId: string,
  tier: Tier,
  end: RunEnd,
  tried: readonly string[],
  prUrl: string | null = null,
): RunFinished {
  const base = { v: 1 as const, runId, prUrl, confidence: null };
  if (end.kind === 'agent' && end.run.exitStatus === 'submitted') {
    return { ...base, status: 'succeeded', note: null };
  }

  const { summary, blocker } = describe(end);
  const note: EscalationNote = {
    summary: clip(summary, SUMMARY_CHARS),
    tried: tried
      .map((t) => clip(t.trim(), TRIED_CHARS))
      .filter((t) => t !== '')
      .slice(-TRIED_LIMIT),
    blocker,
  };
  if (end.kind === 'killed') return { ...base, status: 'killed', note };
  if (end.kind === 'agent' && isBudget(end.run) && tier < 3) {
    const toTier = (tier + 1) as Tier;
    return { ...base, status: 'escalated', reason: 'budget_exhausted', toTier, note };
  }
  return { ...base, status: 'failed', note };
}

const isBudget = ({ exitStatus }: AgentRun) =>
  exitStatus === 'step_limit' || exitStatus === 'cost_limit' || exitStatus === 'time_limit';

function describe(end: RunEnd): { summary: string; blocker: string } {
  switch (end.kind) {
    case 'no_report':
      return {
        summary: 'The fix job carried no error report, so the agent had nothing to work from.',
        blocker: 'The job needs a `report`; triage (#30) attaches one.',
      };
    case 'sandbox_failed':
      return { summary: 'The sandbox container did not start.', blocker: end.message };
    case 'crashed':
      return { summary: 'The run stopped on a daemon error.', blocker: end.message };
    case 'expired':
      return {
        summary: 'The job queue gave up on the run before it finished.',
        blocker: 'The pg-boss job expired, so the daemon stopped the sandbox.',
      };
    case 'killed':
      return {
        summary: 'The run was killed before it finished.',
        blocker: 'Someone stopped the run, so the daemon removed its sandbox.',
      };
    case 'agent':
      return describeAgent(end.run);
  }
}

function describeAgent(run: AgentRun): { summary: string; blocker: string } {
  const spent = `${run.modelCalls} model calls, $${run.costUsd.toFixed(2)}`;
  switch (run.exitStatus) {
    case 'step_limit':
      return { summary: `The agent hit its step limit (${spent}).`, blocker: 'Out of steps.' };
    case 'cost_limit':
      return { summary: `The agent hit its cost limit (${spent}).`, blocker: 'Out of budget.' };
    case 'time_limit':
      return { summary: `The agent ran out of time (${spent}).`, blocker: 'Out of time.' };
    case 'format_errors':
      return {
        summary: `The model kept replying without a usable action (${spent}).`,
        blocker: 'Too many badly formatted replies in a row.',
      };
    case 'model_error':
      return {
        summary: `The model call failed (${spent}).`,
        blocker: run.error ? `${run.error.kind}: ${run.error.message}` : 'model error',
      };
    case 'audit_failed':
      return {
        summary: 'A step could not be written to the audit log, so the run stopped.',
        blocker: run.auditError ?? 'audit log write failed',
      };
    case 'aborted':
      return { summary: `The run was stopped (${spent}).`, blocker: 'Stopped before it finished.' };
    case 'submitted':
      // Handled by the caller; here only so the switch covers every status.
      return { summary: 'The agent submitted.', blocker: 'none' };
  }
}
