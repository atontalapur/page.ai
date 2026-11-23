import type { Approval, DecidedApproval, PendingApproval } from '@page/contracts';
import { pendingApprovalFixture } from '@page/contracts/fixtures';
import { describe, expect, it } from 'vitest';
import {
  approveMode,
  approverIdentity,
  E2E_APPROVER_NAME,
  E2EApprover,
  type ApproverIdentity,
  type ApproverSocket,
  type OrchestratorGet,
} from './e2e-approvals.ts';

const RUN = '00000000-0000-4000-8000-0000000000c3';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000d4';

let n = 0;
function pending(fields: Partial<PendingApproval> = {}): PendingApproval {
  n += 1;
  return {
    ...pendingApprovalFixture,
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    runId: RUN,
    action: 'ops.restart',
    args: { tool: 'ops.restart' },
    ...fields,
  };
}

function decided(approval: Approval, fields: Partial<DecidedApproval> = {}): DecidedApproval {
  return {
    ...approval,
    decision: 'approved',
    decidedBy: 'ui:e2e',
    decidedAt: '2026-11-23T12:00:05.000Z',
    ...fields,
  };
}

/** Plays the socket.io-client socket the approver opens. */
class FakeSocket implements ApproverSocket {
  readonly handlers = new Map<string, (payload: unknown) => void>();
  readonly emitted: unknown[] = [];
  closed = false;
  readonly auth: { token: string; name?: string };
  constructor(auth: { token: string; name?: string }) {
    this.auth = auth;
  }
  on(event: string, listener: (payload: unknown) => void) {
    this.handlers.set(event, listener);
    return this;
  }
  emit(_event: 'approval.decide', payload: unknown) {
    this.emitted.push(payload);
    return this;
  }
  close() {
    this.closed = true;
  }
  fire(event: string, payload?: unknown) {
    this.handlers.get(event)?.(payload);
  }
  requested(approval: Approval) {
    this.fire('approval.requested', { v: 1, approval });
  }
  updated(approval: DecidedApproval) {
    this.fire('approval.updated', { v: 1, approval });
  }
}

interface Rig {
  approver: E2EApprover;
  socket: () => FakeSocket;
  lines: string[];
  gets: string[];
  /** What GET /approvals?runId= answers next, per run. */
  lists: Map<string, { status: number; body: unknown } | Error>;
}

function rig(
  identity: Exclude<ApproverIdentity, { kind: 'none' }> = { kind: 'label', name: 'e2e' },
): Rig {
  const sockets: FakeSocket[] = [];
  const lines: string[] = [];
  const gets: string[] = [];
  const lists = new Map<string, { status: number; body: unknown } | Error>();
  const get: OrchestratorGet = (path) => {
    gets.push(path);
    const runId = new URLSearchParams(path.split('?')[1]).get('runId') ?? '';
    const answer = lists.get(runId) ?? { status: 200, body: [] };
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  const approver = new E2EApprover(
    {
      connect: (auth) => {
        const socket = new FakeSocket(auth);
        sockets.push(socket);
        return socket;
      },
      get,
      now: () => Date.parse('2026-11-23T12:00:00.000Z'),
      log: (line) => lines.push(line),
    },
    identity,
    'the-token',
  );
  return { approver, socket: () => sockets.at(-1)!, lines, gets, lists };
}

/** Lets the loads the approver started settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const decide = (approvalId: string) => ({ v: 1, approvalId, decision: 'approved' });

describe('approveMode', () => {
  it('approves by default, and leaves the outcome --expect approval waits for to a person', () => {
    expect(approveMode(undefined, 'resolved')).toBe('auto');
    expect(approveMode(undefined, 'pr')).toBe('auto');
    expect(approveMode(undefined, 'approval')).toBe('manual');
    expect(approveMode('manual', 'resolved')).toBe('manual');
    expect(approveMode('auto', 'resolved')).toBe('auto');
  });

  it('refuses --approve auto with --expect approval, and an unknown mode', () => {
    expect(() => approveMode('auto', 'approval')).toThrow('--approve auto would approve');
    expect(() => approveMode('yes', 'resolved')).toThrow('--approve must be auto or manual');
  });
});

describe('approverIdentity', () => {
  const answering =
    (status: number, body?: unknown): OrchestratorGet =>
    (path) => {
      expect(path).toBe('/me');
      return Promise.resolve({ status, body });
    };

  it('decides as the person a personal token names', async () => {
    const identity = await approverIdentity(answering(200, { token: 'personal', name: 'e2e' }));
    expect(identity).toEqual({ kind: 'person', name: 'e2e' });
  });

  it('decides under the e2e label where the shared token may, or /me is older', async () => {
    const label = { kind: 'label', name: E2E_APPROVER_NAME };
    expect(await approverIdentity(answering(200, { token: 'shared', canDecide: true }))).toEqual(
      label,
    );
    expect(await approverIdentity(answering(404, { statusCode: 404 }))).toEqual(label);
  });

  it('says why the shared token cannot decide once personal tokens exist', async () => {
    const identity = await approverIdentity(answering(200, { token: 'shared', canDecide: false }));
    expect(identity).toMatchObject({ kind: 'none' });
    expect((identity as { reason: string }).reason).toContain(
      'pnpm --filter @page/orchestrator dashboard-token e2e',
    );
    expect((identity as { reason: string }).reason).toContain('--approve manual');
  });

  it('throws for a refused token, another status, or a body it cannot read', async () => {
    await expect(approverIdentity(answering(401))).rejects.toThrow('refused the token');
    await expect(approverIdentity(answering(429))).rejects.toThrow('GET /me answered 429');
    await expect(approverIdentity(answering(200, { token: 'admin' }))).rejects.toThrow(
      'cannot read',
    );
  });
});

describe('E2EApprover', () => {
  it('connects with the e2e name only when it decides under a label', () => {
    const label = rig();
    label.approver.start();
    expect(label.socket().auth).toEqual({ token: 'the-token', name: 'e2e' });
    expect(label.approver.decider).toBe('ui:e2e');

    const person = rig({ kind: 'person', name: 'harness' });
    person.approver.start();
    expect(person.socket().auth).toEqual({ token: 'the-token' });
    expect(person.approver.decider).toBe('ui:harness');
  });

  it("approves a watched run's request once, and records the decision that stands", async () => {
    const { approver, socket, lines } = rig();
    approver.start();
    approver.watch(RUN);
    await settle();
    const ask = pending();
    socket().requested(ask);
    socket().requested(ask);

    expect(socket().emitted).toEqual([decide(ask.id)]);
    expect(approver.approvals([RUN])).toEqual([
      {
        approvalId: ask.id,
        runId: RUN,
        action: 'ops.restart',
        sentAt: '2026-11-23T12:00:00.000Z',
        decision: null,
        decidedBy: null,
      },
    ]);
    socket().updated(decided(ask));
    expect(approver.approvals([RUN])).toMatchObject([
      { decision: 'approved', decidedBy: 'ui:e2e' },
    ]);
    expect(lines).toContain(`[approve] approved ops.restart for run ${RUN} as ui:e2e`);
    // A second answer doesn't change what stood.
    socket().updated(decided(ask, { decidedBy: 'ui:Arjun' }));
    expect(approver.approvals([RUN])[0]?.decidedBy).toBe('ui:e2e');
  });

  it("never approves another run's request, and approves an early one once its run is watched", async () => {
    const { approver, socket } = rig();
    approver.start();
    const early = pending();
    const elsewhere = pending({ runId: OTHER_RUN });
    socket().requested(early);
    socket().requested(elsewhere);
    expect(socket().emitted).toEqual([]);

    approver.watch(RUN);
    approver.watch(RUN);
    await settle();
    expect(socket().emitted).toEqual([decide(early.id)]);
    expect(approver.approvals([RUN, OTHER_RUN]).map((a) => a.approvalId)).toEqual([early.id]);
  });

  it('loads what it missed when it watches a run and after each reconnect', async () => {
    const { approver, socket, gets, lists } = rig();
    const missed = pending();
    const done = decided(pending());
    lists.set(RUN, { status: 200, body: [done, missed] });
    approver.start();
    approver.watch(RUN);
    await settle();
    expect(gets).toEqual([`/approvals?runId=${RUN}`]);
    expect(socket().emitted).toEqual([decide(missed.id)]);

    const later = pending();
    lists.set(RUN, { status: 200, body: [done, missed, later] });
    socket().fire('connect');
    await settle();
    expect(gets).toHaveLength(2);
    expect(socket().emitted).toEqual([decide(missed.id), decide(later.id)]);
  });

  it('waits for its socket before approving a request it loaded', async () => {
    const { approver, socket, lists } = rig();
    const ask = pending();
    lists.set(RUN, { status: 200, body: [ask] });
    approver.watch(RUN);
    await settle();
    expect(approver.approvals([RUN])).toEqual([]);

    approver.start();
    socket().fire('connect');
    await settle();
    expect(socket().emitted).toEqual([decide(ask.id)]);
  });

  it('records a request that someone or something else decided first', async () => {
    const { approver, socket, lines } = rig();
    approver.start();
    approver.watch(RUN);
    await settle();
    const ask = pending();
    socket().requested(ask);
    socket().updated(decided(ask, { decision: 'rejected', decidedBy: 'system:timed_out' }));
    expect(approver.approvals([RUN])).toMatchObject([
      { decision: 'rejected', decidedBy: 'system:timed_out' },
    ]);
    expect(lines.at(-1)).toBe(
      `[approve] ops.restart for run ${RUN} was rejected by system:timed_out before the ` +
        "harness's approval counted",
    );
  });

  it('stops approving once released, and can watch again after', async () => {
    const { approver, socket } = rig();
    approver.start();
    approver.watch(RUN);
    await settle();
    approver.release();
    const late = pending();
    socket().requested(late);
    expect(socket().emitted).toEqual([]);

    approver.watch(OTHER_RUN);
    await settle();
    const next = pending({ runId: OTHER_RUN });
    socket().requested(next);
    expect(socket().emitted).toEqual([decide(next.id)]);
  });

  it('logs a load that fails or a payload that breaks the contract, and goes on', async () => {
    const { approver, socket, lines, lists } = rig();
    approver.start();
    lists.set(RUN, { status: 500, body: undefined });
    approver.watch(RUN);
    lists.set(OTHER_RUN, { status: 200, body: [{ id: 'nope' }] });
    approver.watch(OTHER_RUN);
    await settle();
    lists.set(RUN, new Error('fetch failed'));
    socket().fire('connect');
    await settle();
    socket().fire('approval.requested', { v: 2, approval: pending() });
    socket().fire('connect_error', new Error('unauthorized'));
    socket().fire('connect_error', 'timeout');

    expect(lines).toEqual([
      `[approve] could not load the requests of run ${RUN}: GET /approvals answered 500`,
      `[approve] could not load the requests of run ${OTHER_RUN}: GET /approvals answered approvals that break the contract`,
      `[approve] could not load the requests of run ${RUN}: fetch failed`,
      `[approve] could not load the requests of run ${OTHER_RUN}: GET /approvals answered approvals that break the contract`,
      '[approve] dropped an approval.requested that breaks the contract',
      "[approve] could not connect to the orchestrator's /ui socket: unauthorized",
      "[approve] could not connect to the orchestrator's /ui socket: timeout",
    ]);
    expect(socket().emitted).toEqual([]);
  });

  it('closes its socket', () => {
    const { approver, socket } = rig();
    approver.start();
    approver.close();
    expect(socket().closed).toBe(true);
    approver.close();
  });
});
