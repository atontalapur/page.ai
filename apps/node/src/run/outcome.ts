import { CONFIDENCE_THRESHOLD, isLowConfidence, type AgentRun } from '@page/agent';
import { clip, type Confidence, type EscalationNote, type Tier } from '@page/contracts';
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

/** What the daemon found out about a run besides how it ended. */
export interface RunFacts {
  /** The PR the run opened, if it got that far. */
  prUrl?: string | null;
  /**
   * A submitted Tier 3 run fixed the live app through the ops API and left no code change.
   * Dropped for any other end.
   */
  opsOnly?: boolean;
  /** A submitted run's score (scoreRun). Null when it wasn't scored; dropped for any other end. */
  confidence?: Confidence | null;
}

// The note keeps the last few commands, in the order they ran, each clipped.
const TRIED_LIMIT = 20;
const TRIED_CHARS = 200;
const SUMMARY_CHARS = 500;

/** Whether the agent ended the run itself, by submitting a fix. */
export const submitted = (end: RunEnd): boolean =>
  end.kind === 'agent' && end.run.exitStatus === 'submitted';

/**
 * The `node.run.finished` event for a run. `tried` is what the agent ran, in order.
 *
 * A submitted run is a success that carries its score, unless the score is under its tier's
 * confidence threshold (threshold.ts in @page/agent). Then it escalates a tier as
 * `low_confidence`, the way a run out of budget escalates as `budget_exhausted`; Tier 3 has
 * nowhere to go, so either one fails there. A run with no score never escalates for want of
 * one. A killed run is `killed`, with what it had tried so far. Everything else is a failure:
 * retrying a broken model, audit log or sandbox at a higher tier won't help.
 */
export function finishedEvent(
  runId: string,
  tier: Tier,
  end: RunEnd,
  tried: readonly string[],
  { prUrl = null, opsOnly = false, confidence = null }: RunFacts = {},
): RunFinished {
  const scored = submitted(end) ? confidence : null;
  const costUsd = end.kind === 'agent' ? end.run.costUsd : 0;
  const base = { v: 1 as const, runId, prUrl, confidence: scored, costUsd };
  const lowScore = scored !== null && isLowConfidence(scored, tier);
  if (submitted(end) && !lowScore) {
    return { ...base, status: 'succeeded', note: null, opsOnly };
  }

  const { summary, blocker } = lowScore ? describeLowScore(end, tier, scored) : describe(end);
  const note: EscalationNote = {
    summary: clip(summary, SUMMARY_CHARS),
    tried: tried
      .map((t) => clip(t.trim(), TRIED_CHARS))
      .filter((t) => t !== '')
      .slice(-TRIED_LIMIT),
    blocker,
  };
  if (end.kind === 'killed') return { ...base, status: 'killed', note };
  const handedUp = end.kind === 'agent' && end.run.exitStatus === 'escalated';
  if (end.kind === 'agent' && (isBudget(end.run) || lowScore || handedUp) && tier < 3) {
    const toTier = (tier + 1) as Tier;
    const reason = handedUp
      ? 'needs_higher_tier'
      : lowScore
        ? 'low_confidence'
        : 'budget_exhausted';
    return { ...base, status: 'escalated', reason, toTier, note };
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

// The most of an agent's own hand-off reason the next tier gets.
const BLOCKER_CHARS = 2_000;

const spentBy = (run: AgentRun) => `${run.modelCalls} model calls, $${run.costUsd.toFixed(2)}`;

/** Why a submitted fix scored too low, from the parts of its score. */
function describeLowScore(
  end: RunEnd,
  tier: Tier,
  confidence: Confidence,
): { summary: string; blocker: string } {
  const spent = end.kind === 'agent' ? ` (${spentBy(end.run)})` : '';
  const summary =
    `The agent submitted a fix that scored ${confidence.score.toFixed(2)} for confidence, ` +
    `under Tier ${tier}'s threshold of ${CONFIDENCE_THRESHOLD[tier]}${spent}.`;
  if (confidence.liveAfterChange === false) {
    return {
      summary,
      blocker:
        'No healthy restart or live rollback came after its last change to the live app, so ' +
        'the app may not serve the fix.',
    };
  }
  if (confidence.changesCode === false) {
    return { summary, blocker: 'Its change touches no code: nothing changed, or only tests.' };
  }
  const missing = [
    ...(confidence.testsPass ? [] : ['no test run passed after its last edit']),
    ...(confidence.checksPass ? [] : ['no typecheck or lint passed after its last edit']),
    ...(confidence.reproduced ? [] : ['no test showed the bug failing before the fix']),
  ].join('; ');
  // A full score is 1 and no threshold is above it, so at least one part is missing here.
  return { summary, blocker: `${missing.charAt(0).toUpperCase()}${missing.slice(1)}.` };
}

function describeAgent(run: AgentRun): { summary: string; blocker: string } {
  const spent = spentBy(run);
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
    case 'escalated':
      return {
        summary: `The agent handed the fix to the tier above (${spent}).`,
        blocker: clip(run.handoff ?? 'It said this tier cannot make the fix.', BLOCKER_CHARS),
      };
    case 'submitted':
      // Handled by the caller; here only so the switch covers every status.
      return { summary: 'The agent submitted.', blocker: 'none' };
  }
}
