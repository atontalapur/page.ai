import type { AgentRun, ExitStatus } from '@page/agent';
import { nodeToServerEvents } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { finishedEvent, type RunEnd } from './outcome.ts';

const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const agent = (exitStatus: ExitStatus, extra: Partial<AgentRun> = {}): RunEnd => ({
  kind: 'agent',
  run: { exitStatus, messages: [], modelCalls: 3, costUsd: 0.1234, ...extra },
});
const schema = nodeToServerEvents['node.run.finished'];

describe('finishedEvent', () => {
  it('reports a submitted run as an unscored success', () => {
    const event = finishedEvent(runId, 1, agent('submitted'), ['ls']);
    expect(event).toEqual({
      v: 1,
      runId,
      status: 'succeeded',
      prUrl: null,
      confidence: null,
      note: null,
    });
    expect(schema.parse(event)).toEqual(event);
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

  it('keeps the note inside the contract limits', () => {
    const tried = Array.from({ length: 30 }, (_, i) => `${i} ${'x'.repeat(300)}`);
    const { note } = finishedEvent(runId, 1, agent('step_limit'), tried);
    expect(note?.tried).toHaveLength(20);
    expect(note?.tried[0]).toMatch(/^10 /);
    expect(note?.tried.every((t) => t.length <= 200)).toBe(true);
  });
});
