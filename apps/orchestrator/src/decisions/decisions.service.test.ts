import { confidenceFixture, escalationNoteFixture } from '@page/contracts/fixtures';
import type { ChoiceAnswer, Decider, DecisionResult } from '@page/model-client';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { RunsService } from '../runs/runs.service.ts';
import { TriageClassifier } from '../triage/classify.ts';
import { DecisionsService } from './decisions.service.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());
const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);

/** A decider that answers every question with `choice` at `confidence`. */
function fakeJev(
  answers: Record<string, string>,
  confidence = 0.9,
): Decider & { states: unknown[] } {
  const states: unknown[] = [];
  return {
    states,
    decide<Q extends string>(
      state: unknown,
      questions: Record<Q, { criteria: Record<string, string> }>,
    ) {
      states.push({ state, questions });
      const out = {} as Record<Q, ChoiceAnswer>;
      for (const q of Object.keys(questions) as Q[]) {
        const choice = answers[q]!;
        out[q] = { choice, probabilities: { [choice]: confidence }, confidence };
      }
      return Promise.resolve({
        ok: true,
        decision: { model: 'typesafe/jev-1.14-test', answers: out, costUsd: 0.00002 },
      } as DecisionResult<Q>);
    },
  };
}

let n = 0;
async function escalated(reason: 'low_confidence' | 'budget_exhausted') {
  const { issue } = await issues.report(
    { fingerprint: `jev-${++n}`, title: 'Boom' },
    'Error: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'backend-api', severity: 'high' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const { current_run_id } = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return {
    v: 1 as const,
    issueId: issue.id,
    tier: 1 as const,
    startedAt: '2026-11-23T10:00:00.000Z',
    finishedAt: '2026-11-23T10:05:00.000Z',
    diff: null,
    result: {
      v: 1 as const,
      runId: current_run_id!,
      status: 'escalated' as const,
      toTier: 2 as const,
      reason,
      note: escalationNoteFixture,
      prUrl: null,
      confidence: reason === 'low_confidence' ? { ...confidenceFixture, score: 0.1 } : null,
    },
  };
}

describe('DecisionsService.escalation', () => {
  it('lets jev retry a low-scoring fix at the same tier, once', async () => {
    const decisions = new DecisionsService(deps.db, fakeJev({ next: 'retry' }), deps.logger);
    const job = await escalated('low_confidence');
    const decided = await decisions.escalation(job);
    expect(decided?.event).toMatchObject({ type: 'retry', runId: job.result.runId });
    expect(decided?.row).toMatchObject({ question: 'escalation', model: 'typesafe/jev-1.14-test' });
  });

  it('queues the retry at the same tier, and offers no second retry there', async () => {
    const jev = fakeJev({ next: 'retry' });
    const decisions = new DecisionsService(deps.db, jev, deps.logger);
    const runs = new RunsService(deps.db, issues, deps.jobs, deps.logger, decisions);
    const job = await escalated('low_confidence');
    await runs.record(job);

    const issue = await issues.get(job.issueId);
    expect(issue).toMatchObject({ status: 'fixing', currentTier: 1 });
    const { current_run_id } = await deps.db
      .selectFrom('issues')
      .select('current_run_id')
      .where('id', '=', job.issueId)
      .executeTakeFirstOrThrow();
    expect(current_run_id).not.toBe(job.result.runId);
    expect((await decisions.list(job.issueId)).map((d) => d.choice)).toEqual(['retry']);

    // The tier has had its first run and one retry: retry is off the table.
    const again = { ...job, result: { ...job.result, runId: current_run_id! } };
    await decisions.escalation(again);
    const asked = jev.states.at(-1) as { questions: { next: { criteria: object } } };
    expect(Object.keys(asked.questions.next.criteria)).toEqual(['escalate', 'page']);
  });

  it('lets jev page a person', async () => {
    const decisions = new DecisionsService(deps.db, fakeJev({ next: 'page' }), deps.logger);
    const decided = await decisions.escalation(await escalated('low_confidence'));
    expect(decided?.event).toMatchObject({ type: 'fail' });
  });

  it('keeps the move up when jev is unsure', async () => {
    const decisions = new DecisionsService(deps.db, fakeJev({ next: 'page' }, 0.3), deps.logger);
    const decided = await decisions.escalation(await escalated('low_confidence'));
    expect(decided?.event).toBeNull();
  });

  it('never asks about a run that hit a limit: the rules move it up', async () => {
    const jev = fakeJev({ next: 'page' });
    const decisions = new DecisionsService(deps.db, jev, deps.logger);
    expect(
      await decisions.escalation((await escalated('budget_exhausted')) as never),
    ).toBeUndefined();
    expect(jev.states).toEqual([]);
  });
});

describe('TriageClassifier with jev', () => {
  it("takes jev's class, starting tier and confidence, with the rules' severity as a floor", async () => {
    const jev = fakeJev({ class: 'infra-config', severity: 'low', startTier: '3' });
    const triage = await new TriageClassifier(null, 1000, jev).classify({
      title: 'POST /api/checkout 500',
      report: 'POST /api/checkout returned 500\nError: payment failed',
    });
    expect(triage).toMatchObject({
      by: 'jev',
      class: 'infra-config',
      startTier: { tier: 3, confidence: 0.9 },
    });
    // Checkout breaking pages as critical by the rules, whatever the model says.
    expect(triage.severity).not.toBe('low');
  });

  it('starts at the tier triage picked when start_fix names none', async () => {
    const { issue } = await issues.report({ fingerprint: `start-${++n}`, title: 'Boom' }, 'Error');
    await issues.apply(issue.id, { type: 'triage', class: 'infra-config', severity: 'high' });
    await issues.setStartTier(issue.id, 3);
    expect((await issues.apply(issue.id, { type: 'start_fix' })).currentTier).toBe(3);
    expect((await issues.events(issue.id)).at(-1)?.event).toEqual({ type: 'start_fix', tier: 3 });
  });
});
