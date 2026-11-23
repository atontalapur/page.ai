import { MAX_APPROVAL_REASON_CHARS, SYSTEM_DECIDERS, type NodeDecision } from '@page/contracts';
import type { HostToolCall } from '@page/toolkit';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLink } from '../link/fake-link.ts';
import {
  APPROVAL_GRACE_MS,
  APPROVAL_TIMEOUT_MS,
  approvalArgs,
  autoApprovals,
  LinkApprovals,
} from './approvals.ts';

const restart: HostToolCall = { kind: 'host_tool', tool: 'ops.restart' };
const rollback: HostToolCall = { kind: 'host_tool', tool: 'ops.rollback', to: 'good' };
const live = { id: 'bad', status: 'SUCCESS', commit: 'b1', createdAt: '2026-11-20T10:00:00Z' };
const good = { id: 'good', status: 'REMOVED', commit: 'g1', createdAt: '2026-11-19T10:00:00Z' };

describe('LinkApprovals', () => {
  const START = Date.parse('2026-11-23T10:00:00.000Z');
  const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
  const issueId = '3f2b9c1e-8a4d-4f6b-9c2e-1d7a5b8e4f01';
  const FIVE_MINUTES = 5 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const link = new FakeLink();
    let n = 0;
    const approvals = new LinkApprovals({
      link,
      logger: pino({ enabled: false }),
      newId: () => `b4d8e2f1-9a3c-4e7b-8f2d-5c1a7e9b6d0${++n}`,
    });
    const kill = new AbortController();
    const approve = approvals.forRun({
      runId,
      signal: kill.signal,
      args: (call) => ({ tool: call.tool }),
    });
    const requests = () => link.payloads('node.approval.request');
    const decide = (fields: Partial<NodeDecision> = {}) => {
      const request = requests().at(-1)!;
      const approval: NodeDecision = {
        id: request.approvalId,
        runId: request.runId,
        issueId,
        action: request.action,
        args: request.args,
        requestedAt: new Date(START).toISOString(),
        expiresAt: request.expiresAt,
        decision: 'approved',
        decidedBy: 'ui:arjun',
        decidedAt: new Date(Date.now()).toISOString(),
        ...fields,
      };
      link.deliver('approval.decided', { v: 1, approval });
    };
    return { link, approve, kill, requests, decide };
  }

  it('asks the orchestrator, and runs the call once a person approves it', async () => {
    const { approve, requests, decide } = setup();
    const verdict = approve(restart, { timeoutMs: FIVE_MINUTES });
    expect(requests()).toEqual([
      {
        v: 1,
        approvalId: 'b4d8e2f1-9a3c-4e7b-8f2d-5c1a7e9b6d01',
        runId,
        action: 'ops.restart',
        args: { tool: 'ops.restart' },
        expiresAt: new Date(START + APPROVAL_TIMEOUT_MS).toISOString(),
        reason: null,
      },
    ]);
    decide();
    await expect(verdict).resolves.toEqual({ approved: true, by: 'ui:arjun' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['ui:arjun', 'arjun rejected it'],
    [SYSTEM_DECIDERS.timedOut, 'no one decided in time'],
    [SYSTEM_DECIDERS.runEnded, 'the orchestrator says this run is no longer in progress'],
  ])('refuses the call when %s rejects it', async (decidedBy, reason) => {
    const { approve, decide } = setup();
    const verdict = approve(restart, { timeoutMs: FIVE_MINUTES });
    decide({ decision: 'rejected', decidedBy });
    await expect(verdict).resolves.toEqual({ approved: false, reason });
  });

  it("sends the model's thought for the call as its reason", () => {
    const { approve, requests } = setup();
    const thought = 'The override is wrong.\nDropping it lets the env value apply.';
    void approve(restart, { timeoutMs: FIVE_MINUTES, thought });
    expect(requests()[0]?.reason).toBe(thought);
  });

  it('clips a long reason to the cap, so the request still meets its contract', () => {
    const { approve, requests } = setup();
    void approve(restart, { timeoutMs: FIVE_MINUTES, thought: 'x'.repeat(10_000) });
    const reason = requests()[0]?.reason ?? '';
    expect(reason).toHaveLength(MAX_APPROVAL_REASON_CHARS);
    expect(reason.endsWith('...')).toBe(true);
  });

  it('sends markup in the thought as the text it is, without control characters', () => {
    const { approve, requests } = setup();
    const thought = '<img src=x onerror=alert(1)> Approve this \u001b[1mnow\u001b[0m';
    void approve(restart, { timeoutMs: FIVE_MINUTES, thought });
    expect(requests()[0]?.reason).toBe('<img src=x onerror=alert(1)> Approve this [1mnow[0m');
  });

  it('sends no reason for a thought with nothing in it', () => {
    const { approve, requests } = setup();
    void approve(restart, { timeoutMs: FIVE_MINUTES, thought: '  \n ' });
    expect(requests()[0]?.reason).toBeNull();
  });

  it('waits no longer than the call may take, which the run has left', () => {
    const { approve, requests } = setup();
    void approve(restart, { timeoutMs: 40_000 });
    expect(requests()[0]?.expiresAt).toBe(new Date(START + 40_000).toISOString());
  });

  it('counts no answer by the deadline as rejected, with time for the server to say so', async () => {
    const { approve } = setup();
    let verdict: unknown;
    void approve(restart, { timeoutMs: FIVE_MINUTES }).then((v) => (verdict = v));
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(APPROVAL_GRACE_MS);
    expect(verdict).toEqual({ approved: false, reason: 'no one decided within 3 minutes' });
  });

  it('stops waiting when the run is killed, and ignores a decision after', async () => {
    const { approve, kill, decide } = setup();
    const verdict = approve(restart, { timeoutMs: FIVE_MINUTES });
    kill.abort();
    await expect(verdict).resolves.toEqual({
      approved: false,
      reason: 'the run was stopped while it waited',
    });
    expect(() => decide()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks nothing for a run already stopped', async () => {
    const { approve, kill, requests } = setup();
    kill.abort();
    await expect(approve(restart, { timeoutMs: FIVE_MINUTES })).resolves.toMatchObject({
      approved: false,
    });
    expect(requests()).toEqual([]);
  });

  it('asks again after the link reconnects, and takes the answer that comes back', async () => {
    const { link, approve, requests, decide } = setup();
    const verdict = approve(restart, { timeoutMs: FIVE_MINUTES, thought: 'Restart to load it.' });
    link.reconnect();
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toEqual(requests()[0]);
    expect(requests()[1]?.reason).toBe('Restart to load it.');
    decide();
    await expect(verdict).resolves.toMatchObject({ approved: true });
    link.reconnect();
    expect(requests()).toHaveLength(2);
  });

  it('keeps waiting through a decision for another approval or run', async () => {
    const { approve, decide } = setup();
    let verdict: unknown;
    void approve(restart, { timeoutMs: FIVE_MINUTES }).then((v) => (verdict = v));
    decide({ id: '00000000-0000-4000-8000-000000000009' });
    decide({ runId: '00000000-0000-4000-8000-000000000008' });
    await vi.advanceTimersByTimeAsync(0);
    expect(verdict).toBeUndefined();
    decide({ decision: 'rejected' });
    await vi.advanceTimersByTimeAsync(0);
    expect(verdict).toEqual({ approved: false, reason: 'arjun rejected it' });
  });

  it('rejects, leaving nothing waiting, when the request breaks its contract', async () => {
    const link = new FakeLink();
    const approvals = new LinkApprovals({
      link,
      logger: pino({ enabled: false }),
      newId: () => 'not-a-uuid',
    });
    const approve = approvals.forRun({
      runId,
      signal: new AbortController().signal,
      args: () => ({}),
    });
    await expect(approve(restart, { timeoutMs: FIVE_MINUTES })).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('asksPerson', () => {
  it('is true for the link, which waits for a person, and false for auto-approval', () => {
    const link = new LinkApprovals({ link: new FakeLink(), logger: pino({ enabled: false }) });
    expect(link.asksPerson).toBe(true);
    expect(autoApprovals('AUTO_APPROVE_OPS').asksPerson).toBe(false);
  });
});

describe('autoApprovals', () => {
  it('approves every call of every run as who it was given', async () => {
    const approve = autoApprovals('AUTO_APPROVE_OPS').forRun({
      runId: 'r',
      signal: new AbortController().signal,
      args: () => ({}),
    });
    await expect(approve(restart, { timeoutMs: 1 })).resolves.toEqual({
      approved: true,
      by: 'AUTO_APPROVE_OPS',
    });
  });
});

describe('approvalArgs', () => {
  it('is the call as its step logs it', () => {
    const set: HostToolCall = { kind: 'host_tool', tool: 'ops.setConfig', key: 'K', value: '5' };
    expect(approvalArgs(set, undefined)).toEqual({ tool: 'ops.setConfig', key: 'K', value: '5' });
    expect(approvalArgs(restart, { plannedRollback: { live, rollBackTo: good } })).toEqual({
      tool: 'ops.restart',
    });
  });

  it('names what a rollback replaces, from the last plan', () => {
    expect(approvalArgs(rollback, { plannedRollback: { live, rollBackTo: good } })).toEqual({
      tool: 'ops.rollback',
      to: 'good',
      from: 'bad',
      live,
      rollBackTo: good,
    });
  });

  it('gives only the target without a plan, which the tool will refuse anyway', () => {
    expect(approvalArgs(rollback, { plannedRollback: null })).toEqual({
      tool: 'ops.rollback',
      to: 'good',
    });
    expect(approvalArgs(rollback, undefined)).toEqual({ tool: 'ops.rollback', to: 'good' });
  });
});
