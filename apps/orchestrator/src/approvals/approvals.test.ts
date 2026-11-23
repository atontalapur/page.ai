import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  approvalSchema,
  MAX_APPROVAL_WAIT_MS,
  NODE_NAMESPACE,
  serverToNodeEvents,
  serverToUiEvents,
  SYSTEM_DECIDERS,
  UI_NAMESPACE,
  type Approval,
  type DecidedApproval,
} from '@page/contracts';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { MESSAGES_PER_10_SECONDS } from '../gateway/ui.gateway.ts';
import { outcome, TestSockets } from '../gateway/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { ApprovalsService, type ApprovalRequest } from './approvals.service.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const nodes = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
const tabs = new TestSockets(`${base}${UI_NAMESPACE}`, '203.0.113');
afterEach(() => {
  nodes.closeAll();
  tabs.closeAll();
  vi.restoreAllMocks();
});

const issues = app.get(IssuesService);
const approvals = app.get(ApprovalsService);
const auth = { authorization: `Bearer ${testConfig.apiToken}` };
let n = 0;

/** An issue in `fixing`, and the run its fix job carries. */
async function fixing(): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report(
    { fingerprint: `approvals-${++n}`, title: 'Boom' },
    'GET /\n\nTypeError: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id ?? '' };
}

async function connected(socket: Socket): Promise<Socket> {
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

const daemon = () => connected(nodes.connect({ token: testConfig.nodeSharedSecret }));
const tab = (name?: string) =>
  connected(tabs.connect({ token: testConfig.apiToken, ...(name === undefined ? {} : { name }) }));

/** Every `event` a socket gets, parsed against its contract as the UI and the daemon do. */
function heard(socket: Socket, event: 'approval.requested' | 'approval.updated'): Approval[];
function heard(socket: Socket, event: 'approval.decided'): DecidedApproval[];
function heard(socket: Socket, event: string): Approval[] {
  const seen: Approval[] = [];
  socket.on(event, (payload: unknown) => {
    const schema =
      event === 'approval.decided'
        ? serverToNodeEvents['approval.decided']
        : serverToUiEvents[event as 'approval.requested' | 'approval.updated'];
    seen.push(schema.parse(payload).approval);
  });
  return seen;
}

const request = (runId: string, fields: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  v: 1,
  approvalId: randomUUID(),
  runId,
  action: 'ops.rollback',
  args: { tool: 'ops.rollback', to: 'good', from: 'bad' },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  ...fields,
});

const row = (id: string) =>
  deps.db.selectFrom('approvals').selectAll().where('id', '=', id).executeTakeFirst();

/** A daemon that asked for `ask`, and two tabs: one named Arjun, one named Daniyal. */
async function asked(fields: Partial<ApprovalRequest> = {}) {
  const run = await fixing();
  const arjun = await tab('Arjun');
  const daniyal = await tab('Daniyal');
  const requested = [heard(arjun, 'approval.requested'), heard(daniyal, 'approval.requested')];
  const updated = [heard(arjun, 'approval.updated'), heard(daniyal, 'approval.updated')];
  const node = await daemon();
  const decided = heard(node, 'approval.decided');
  const ask = request(run.runId, fields);
  node.emit('node.approval.request', ask);
  return { ...run, ask, node, decided, arjun, daniyal, requested, updated };
}

describe('a daemon asks', () => {
  it('stores the request pending and shows it to every tab', async () => {
    const { ask, issueId, runId, requested } = await asked();
    await expect.poll(() => requested.map((r) => r.length)).toEqual([1, 1]);
    const pending = {
      id: ask.approvalId,
      runId,
      issueId,
      action: 'ops.rollback',
      args: ask.args,
      decision: 'pending',
      decidedBy: null,
      decidedAt: null,
      expiresAt: ask.expiresAt,
    };
    expect(requested[0]![0]).toMatchObject(pending);
    expect(await row(ask.approvalId)).toMatchObject({ decision: 'pending', issue_id: issueId });
  });

  it('holds a deadline to the longest a run could wait', async () => {
    const far = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { ask, requested } = await asked({ expiresAt: far });
    await expect.poll(() => requested[0]!.length).toBe(1);
    const expiresAt = Date.parse(requested[0]![0]!.expiresAt);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + MAX_APPROVAL_WAIT_MS);
    expect((await row(ask.approvalId))?.expires_at.getTime()).toBe(expiresAt);
  });

  it('answers at once a run that is no longer in progress, and shows no tab', async () => {
    const { issueId, runId } = await fixing();
    await issues.apply(issueId, { type: 'kill' });
    const watching = await tab('Arjun');
    const requested = heard(watching, 'approval.requested');
    const node = await daemon();
    const decided = heard(node, 'approval.decided');
    const ask = request(runId);
    node.emit('node.approval.request', ask);
    await expect
      .poll(() => decided)
      .toMatchObject([
        { id: ask.approvalId, decision: 'rejected', decidedBy: SYSTEM_DECIDERS.runEnded },
      ]);
    expect(requested).toEqual([]);
  });

  it('drops a request for a run no issue knows, and an id another run already used', async () => {
    const node = await daemon();
    const unknown = request(randomUUID());
    node.emit('node.approval.request', unknown);
    const { ask, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    const other = await fixing();
    node.emit('node.approval.request', { ...request(other.runId), approvalId: ask.approvalId });
    // Handled in order after the drop, so the row is checked once it has been.
    node.emit('node.diff', { v: 1, runId: other.runId, diff: '' });
    await expect.poll(async () => (await approvals.forRun(other.runId)).length).toBe(0);
    expect(await row(unknown.approvalId)).toBeUndefined();
    expect((await row(ask.approvalId))?.run_id).not.toBe(other.runId);
  });
});

describe('a person decides', () => {
  it('records the decision under the name the tab connected with, for the daemon and every tab', async () => {
    const { ask, arjun, decided, updated } = await asked();
    await expect.poll(async () => (await row(ask.approvalId))?.decision).toBe('pending');
    arjun.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'approved' });

    await expect
      .poll(() => decided)
      .toMatchObject([{ id: ask.approvalId, decision: 'approved', decidedBy: 'ui:Arjun' }]);
    await expect.poll(() => updated.map((u) => u.length)).toEqual([1, 1]);
    expect(updated[1]![0]).toMatchObject({ decision: 'approved', decidedBy: 'ui:Arjun' });
    expect(await row(ask.approvalId)).toMatchObject({
      decision: 'approved',
      decided_by: 'ui:Arjun',
    });
  });

  it('refuses a second decision, and shows the tab that sent it the one that stands', async () => {
    const { ask, arjun, daniyal, decided, updated } = await asked();
    await expect.poll(async () => (await row(ask.approvalId))?.decision).toBe('pending');
    arjun.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'rejected' });
    await expect.poll(() => decided.length).toBe(1);
    daniyal.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'approved' });

    // Daniyal's tab hears the standing decision a second time, sent to it alone.
    await expect.poll(() => updated.map((u) => u.length)).toEqual([1, 2]);
    expect(updated[1]![1]).toMatchObject({ decision: 'rejected', decidedBy: 'ui:Arjun' });
    expect(decided).toHaveLength(1);
    expect(await row(ask.approvalId)).toMatchObject({
      decision: 'rejected',
      decided_by: 'ui:Arjun',
    });
    await expect(approvals.decide(ask.approvalId, 'approved', 'ui:Daniyal')).resolves.toMatchObject(
      {
        kind: 'already_decided',
        approval: { decision: 'rejected' },
      },
    );
  });

  it('takes who decided from the socket, never from the payload or a name it may not use', async () => {
    const { ask, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    const nameless = await tab();
    const posing = await tab(SYSTEM_DECIDERS.timedOut);
    const decide = { v: 1, approvalId: ask.approvalId, decision: 'approved' };
    nameless.emit('approval.decide', decide);
    posing.emit('approval.decide', decide);
    const named = await tab('Nidheesh');
    named.emit('approval.decide', { ...decide, decidedBy: 'Arjun' });
    // A probe on a run nothing holds: once it is handled, so are the decisions before it.
    named.emit('approval.decide', { ...decide, approvalId: randomUUID() });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await row(ask.approvalId)).toMatchObject({ decision: 'pending', decided_by: null });
  });

  it('closes a tab that sends decisions past the message limit', async () => {
    const socket = await tab('Arjun');
    const closed = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    for (let i = 0; i <= MESSAGES_PER_10_SECONDS; i++) {
      socket.emit('approval.decide', { v: 1, approvalId: randomUUID(), decision: 'approved' });
    }
    expect(await closed).toBe('io server disconnect');
  });
});

describe('the server closes a request', () => {
  it('rejects it as timed out at its deadline, and refuses a decision after', async () => {
    const { ask, arjun, decided, updated } = await asked({
      expiresAt: new Date(Date.now() + 300).toISOString(),
    });
    await expect
      .poll(() => decided)
      .toMatchObject([
        { id: ask.approvalId, decision: 'rejected', decidedBy: SYSTEM_DECIDERS.timedOut },
      ]);
    await expect.poll(() => updated[0]!.length).toBe(1);
    arjun.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'approved' });
    await expect.poll(() => updated[0]!.length).toBe(2);
    expect(await row(ask.approvalId)).toMatchObject({ decided_by: SYSTEM_DECIDERS.timedOut });
  });

  it('refuses a decision past the deadline before its timer has fired', async () => {
    const { issueId, runId } = await fixing();
    const id = randomUUID();
    await deps.db
      .insertInto('approvals')
      .values({
        id,
        run_id: runId,
        issue_id: issueId,
        action: 'ops.restart',
        expires_at: new Date(Date.now() - 1000),
      })
      .execute();
    await expect(approvals.decide(id, 'approved', 'ui:Arjun')).resolves.toMatchObject({
      kind: 'expired',
      approval: { decision: 'rejected', decidedBy: SYSTEM_DECIDERS.timedOut },
    });
    await expect(approvals.decide(randomUUID(), 'approved', 'ui:Arjun')).resolves.toEqual({
      kind: 'not_found',
    });
  });

  it("closes a run's open requests when it finishes", async () => {
    const { ask, runId, node, updated, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    node.emit('node.run.finished', {
      v: 1,
      runId,
      status: 'failed',
      prUrl: null,
      confidence: null,
      note: null,
    });
    await expect
      .poll(() => updated[0])
      .toMatchObject([
        { id: ask.approvalId, decision: 'rejected', decidedBy: SYSTEM_DECIDERS.runEnded },
      ]);
  });

  it('closes them when the issue is killed, and tells the daemon still on the run', async () => {
    const { ask, issueId, decided, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    await issues.apply(issueId, { type: 'kill' });
    await expect
      .poll(() => decided)
      .toMatchObject([{ id: ask.approvalId, decidedBy: SYSTEM_DECIDERS.runEnded }]);
  });

  it('closes them when the issue moves to the next tier', async () => {
    const { ask, issueId, runId, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    await issues.apply(issueId, { type: 'escalate', runId, reason: 'needs_higher_tier: x' });
    await expect
      .poll(async () => (await row(ask.approvalId))?.decided_by)
      .toBe(SYSTEM_DECIDERS.runEnded);
  });
});

describe('a daemon that reconnects', () => {
  it('gets the decision made while it was away when it asks again', async () => {
    const { ask, node, arjun, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    node.close();
    arjun.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'approved' });
    await expect.poll(async () => (await row(ask.approvalId))?.decision).toBe('approved');

    const back = await daemon();
    const decided = heard(back, 'approval.decided');
    back.emit('node.approval.request', ask);
    await expect
      .poll(() => decided)
      .toMatchObject([{ id: ask.approvalId, decision: 'approved', decidedBy: 'ui:Arjun' }]);
    // The tabs knew already; asking again doesn't show the request again.
    expect(requested[0]).toHaveLength(1);
  });

  it('keeps waiting on a request still open when it asks again', async () => {
    const { ask, node, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    node.emit('node.approval.request', ask);
    node.emit('node.diff', { v: 1, runId: ask.runId, diff: '' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(requested[0]).toHaveLength(1);
    expect(await row(ask.approvalId)).toMatchObject({ decision: 'pending' });
  });
});

describe('GET /approvals', () => {
  it("lists an issue's or a run's approvals, oldest first, pending and decided", async () => {
    const { ask, issueId, runId, node, arjun, requested } = await asked();
    await expect.poll(() => requested[0]!.length).toBe(1);
    const second = request(runId, { action: 'ops.restart', args: { tool: 'ops.restart' } });
    node.emit('node.approval.request', second);
    await expect.poll(() => requested[0]!.length).toBe(2);
    arjun.emit('approval.decide', { v: 1, approvalId: ask.approvalId, decision: 'approved' });
    await expect.poll(async () => (await row(ask.approvalId))?.decision).toBe('approved');

    for (const query of [`issueId=${issueId}`, `runId=${runId}`]) {
      const res = await app.inject({ method: 'GET', url: `/approvals?${query}`, headers: auth });
      expect(res.statusCode).toBe(200);
      const listed = approvalSchema.array().parse(res.json());
      expect(listed.map((a) => [a.id, a.decision])).toEqual([
        [ask.approvalId, 'approved'],
        [second.approvalId, 'pending'],
      ]);
    }
    const none = await app.inject({
      method: 'GET',
      url: `/approvals?runId=${randomUUID()}`,
      headers: auth,
    });
    expect(none.json()).toEqual([]);
  });

  it('needs exactly one of issueId and runId, as a uuid, and an issue that exists', async () => {
    const get = (query: string) =>
      app.inject({ method: 'GET', url: `/approvals${query}`, headers: auth });
    const id = randomUUID();
    expect((await get('')).statusCode).toBe(400);
    expect((await get(`?issueId=${id}&runId=${id}`)).statusCode).toBe(400);
    expect((await get('?runId=nope')).statusCode).toBe(400);
    expect((await get(`?issueId=${id}`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/approvals?runId=${id}` })).statusCode).toBe(
      401,
    );
  });

  it('answers 500 when the store fails', async () => {
    vi.spyOn(approvals, 'forIssue').mockRejectedValueOnce(new Error('database is down'));
    const res = await app.inject({
      method: 'GET',
      url: `/approvals?issueId=${randomUUID()}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
  });
});

describe('ApprovalsService', () => {
  it('sets a deadline at boot for each request left pending, closing those already past', async () => {
    const { issueId, runId } = await fixing();
    const insert = (expires: number) => {
      const id = randomUUID();
      return deps.db
        .insertInto('approvals')
        .values({
          id,
          run_id: runId,
          issue_id: issueId,
          action: 'ops.restart',
          expires_at: new Date(Date.now() + expires),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    };
    const past = await insert(-1000);
    const soon = await insert(300);
    const later = await insert(60_000);
    await approvals.onApplicationBootstrap();
    await expect.poll(async () => (await row(past.id))?.decided_by).toBe(SYSTEM_DECIDERS.timedOut);
    await expect.poll(async () => (await row(soon.id))?.decided_by).toBe(SYSTEM_DECIDERS.timedOut);
    expect(await row(later.id)).toMatchObject({ decision: 'pending' });
  });

  it('keeps telling the other listeners when one throws', async () => {
    const seen: string[] = [];
    const off = [
      approvals.subscribe(() => {
        throw new Error('listener broke');
      }),
      approvals.subscribe((approval) => seen.push(approval.id)),
    ];
    const { runId } = await fixing();
    const ask = request(runId);
    await approvals.request(ask);
    expect(seen).toEqual([ask.approvalId]);
    for (const unsubscribe of off) unsubscribe();
  });

  it('logs a close it could not make, at a deadline or for a run that ended', async () => {
    const errors = vi.spyOn(deps.logger, 'error');
    const close = vi
      .spyOn(approvals as unknown as { close: () => Promise<never> }, 'close')
      .mockRejectedValue(new Error('database is down'));
    const { issueId, runId } = await fixing();
    await approvals.request(request(runId, { expiresAt: new Date(Date.now() + 50).toISOString() }));
    await issues.apply(issueId, { type: 'kill' });
    await expect
      .poll(() => errors.mock.calls.map((call) => call[1]))
      .toEqual(
        expect.arrayContaining([
          'could not time out an approval',
          'could not close the approvals of a run that ended',
        ]),
      );
    close.mockRestore();
  });
});
