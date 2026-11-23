import { CONFIDENCE_THRESHOLD, type AgentRun, type ExitStatus } from '@page/agent';
import { nodeToServerEvents, type Confidence } from '@page/contracts';
import { confidenceFixture } from '@page/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import { finishedEvent, type RunEnd } from './outcome.ts';

const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const agent = (exitStatus: ExitStatus, extra: Partial<AgentRun> = {}): RunEnd => ({
  kind: 'agent',
  run: { exitStatus, messages: [], modelCalls: 3, costUsd: 0.1234, ...extra },
});
const schema = nodeToServerEvents['node.run.finished'];
// A code fix submitted with nothing run after its last edit.
const untested: Confidence = {
  score: 0,
  changesCode: true,
  reproduced: false,
  testsPass: false,
  checksPass: false,
  liveAfterChange: null,
};

describe('finishedEvent', () => {
  it('reports a submitted run as an unscored success', () => {
    const event = finishedEvent(runId, 1, agent('submitted'), ['ls']);
    expect(event).toEqual({
      v: 1,
      runId,
      status: 'succeeded',
      prUrl: null,
      confidence: null,
      // What the agent spent, for the dashboard's spend count.
      costUsd: 0.1234,
      note: null,
      opsOnly: false,
    });
    expect(schema.parse(event)).toEqual(event);
  });

  it.each([1, 2, 3] as const)('never escalates an unscored run at Tier %i', (tier) => {
    expect(finishedEvent(runId, tier, agent('submitted'), [], { confidence: null })).toMatchObject({
      status: 'succeeded',
      confidence: null,
    });
  });

  it('carries the score of a run that scored at or above the threshold', () => {
    const confidence = { ...confidenceFixture, score: CONFIDENCE_THRESHOLD[1] };
    const event = finishedEvent(runId, 1, agent('submitted'), [], { confidence });
    expect(event).toMatchObject({ status: 'succeeded', confidence });
    expect(schema.parse(event)).toEqual(event);
  });

  it.each([1, 2] as const)('escalates a Tier %i run that scored under the threshold', (tier) => {
    const event = finishedEvent(runId, tier, agent('submitted'), ['ls', 'pnpm test'], {
      confidence: untested,
    });
    expect(event).toMatchObject({
      status: 'escalated',
      reason: 'low_confidence',
      toTier: tier + 1,
      confidence: untested,
      note: {
        tried: ['ls', 'pnpm test'],
        blocker:
          'No test run passed after its last edit; no typecheck or lint passed after its ' +
          'last edit; no test showed the bug failing before the fix.',
      },
    });
    expect(event.note?.summary).toBe(
      `The agent submitted a fix that scored 0.00 for confidence, under Tier ${tier}'s ` +
        `threshold of ${CONFIDENCE_THRESHOLD[tier]} (3 model calls, $0.12).`,
    );
    expect(event).not.toHaveProperty('opsOnly');
    expect(schema.parse(event)).toEqual(event);
  });

  it('fails a Tier 3 run that scored under the threshold, since there is no tier above', () => {
    const event = finishedEvent(runId, 3, agent('submitted'), [], { confidence: untested });
    expect(event).toMatchObject({ status: 'failed', confidence: untested });
    expect(schema.parse(event)).toEqual(event);
  });

  it.each([
    [
      'an ops fix the app may not serve',
      { ...untested, changesCode: false, liveAfterChange: false },
      /No healthy restart or live rollback/,
    ],
    ['a change to tests only', { ...untested, changesCode: false }, /touches no code/],
    [
      // The scorer gives this fix 0.2, which the calibrated threshold lets land; the score here
      // stays under every tier's threshold so the note's wording is still checked.
      'a fix that only saw the bug fail',
      { ...untested, reproduced: true, score: 0.1 },
      /^No test run passed after its last edit; no typecheck or lint passed after its last edit\.$/,
    ],
  ])('says what was missing from %s', (_, confidence, blocker) => {
    const event = finishedEvent(runId, 3, agent('submitted'), [], { opsOnly: true, confidence });
    expect(event.note?.blocker).toMatch(blocker);
  });

  it('drops a score from a run that did not submit', () => {
    const event = finishedEvent(runId, 1, agent('step_limit'), [], { confidence: untested });
    expect(event).toMatchObject({ status: 'escalated', reason: 'budget_exhausted' });
    expect(event.confidence).toBeNull();
  });

  it('says whether a submitted run fixed the live app with no code change', () => {
    const event = finishedEvent(runId, 3, agent('submitted'), [], { opsOnly: true });
    expect(event).toMatchObject({ status: 'succeeded', opsOnly: true });
    expect(schema.parse(event)).toEqual(event);
    // Only a success carries it.
    const failed = finishedEvent(runId, 3, agent('step_limit'), [], { opsOnly: true });
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed).not.toHaveProperty('opsOnly');
  });

  it('carries the PR the run opened', () => {
    const prUrl = 'https://github.com/acme/shop/pull/4';
    const event = finishedEvent(runId, 2, agent('submitted'), [], { prUrl });
    expect(event).toMatchObject({ status: 'succeeded', prUrl });
    expect(schema.parse(event)).toEqual(event);
    expect(finishedEvent(runId, 2, { kind: 'killed' }, [], { prUrl })).toMatchObject({ prUrl });
  });

  it.each(['step_limit', 'cost_limit', 'time_limit'] as const)(
    'escalates a %s to the next tier with what was tried',
    (status) => {
      const event = finishedEvent(runId, 1, agent(status), ['ls', '  ', 'cat a.ts']);
      expect(event).toMatchObject({
        status: 'escalated',
        reason: 'budget_exhausted',
        toTier: 2,
        note: { tried: ['ls', 'cat a.ts'] },
      });
      expect(event.note?.summary).toContain('3 model calls, $0.12');
      expect(schema.parse(event)).toEqual(event);
    },
  );

  it('fails a Tier 3 run out of budget, since there is no tier above', () => {
    expect(finishedEvent(runId, 3, agent('step_limit'), [])).toMatchObject({ status: 'failed' });
  });

  it.each<[string, RunEnd, RegExp]>([
    ['format errors', agent('format_errors'), /badly formatted/],
    [
      'a model error',
      agent('model_error', { error: { kind: 'auth', status: 401, message: 'bad key' } }),
      /auth: bad key/,
    ],
    ['a model error without detail', agent('model_error'), /model error/],
    ['an audit failure', agent('audit_failed', { auditError: 'db down' }), /db down/],
    ['an audit failure without detail', agent('audit_failed'), /audit log write failed/],
    ['a missing report', { kind: 'no_report' }, /report/],
    ['a sandbox that did not start', { kind: 'sandbox_failed', message: 'no image' }, /no image/],
    ['a daemon crash', { kind: 'crashed', message: 'runner broke' }, /runner broke/],
    ['an expired job', { kind: 'expired' }, /expired/],
  ])('fails on %s', (_, end, blocker) => {
    const event = finishedEvent(runId, 2, end, []);
    expect(event.status).toBe('failed');
    expect(event.note?.blocker).toMatch(blocker);
    expect(schema.parse(event)).toEqual(event);
  });

  it('reports a killed run as killed, with what it tried', () => {
    const event = finishedEvent(runId, 2, { kind: 'killed' }, ['ls']);
    expect(event).toMatchObject({
      status: 'killed',
      note: { tried: ['ls'], blocker: /stopped the run/ },
    });
    expect(schema.parse(event)).toEqual(event);
  });

  it('describes an agent that stopped on its abort signal', () => {
    const event = finishedEvent(runId, 1, agent('aborted'), []);
    expect(event).toMatchObject({ status: 'failed', note: { blocker: /Stopped/ } });
  });

  it('keeps the note inside the contract limits', () => {
    const tried = Array.from({ length: 30 }, (_, i) => `${i} ${'x'.repeat(300)}`);
    const { note } = finishedEvent(runId, 1, agent('step_limit'), tried);
    expect(note?.tried).toHaveLength(20);
    expect(note?.tried[0]).toMatch(/^10 /);
    expect(note?.tried.every((t) => t.length <= 200)).toBe(true);
  });
});
