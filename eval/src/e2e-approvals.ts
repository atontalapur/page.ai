import {
  approvalSchema,
  deciderFor,
  serverToUiEvents,
  sessionSchema,
  type Approval,
} from '@page/contracts';
import type { ApproveMode, E2EApproval, Expectation, RunApprover } from './e2e.ts';

// The end-to-end test's side of a Tier 3 approval (#176). An ops run asks a person before
// each gated call; the harness connects to the orchestrator's /ui socket as itself and
// approves its own runs' requests as they arrive, through the same path a person's click
// takes, so `decidedBy` names the harness. `--approve manual` leaves them to a person.

/** The name the harness decides under where the orchestrator takes name labels. */
export const E2E_APPROVER_NAME = 'e2e';

/**
 * The `--approve` mode for a run. `auto` unless asked for `manual`, or the run expects a
 * pending approval request as its outcome (`--expect approval`), which approving would take
 * away. Throws for `--approve auto` with `--expect approval`.
 */
export function approveMode(flag: string | undefined, expect: Expectation): ApproveMode {
  if (flag !== undefined && flag !== 'auto' && flag !== 'manual') {
    throw new Error(`--approve must be auto or manual, not ${flag}`);
  }
  if (flag === 'auto' && expect === 'approval') {
    throw new Error(
      '--approve auto would approve the request that --expect approval waits for; ' +
        'leave --approve out or pass --approve manual',
    );
  }
  return flag ?? (expect === 'approval' ? 'manual' : 'auto');
}

/**
 * Who the harness decides as, from GET /me: the person its token names, the label `e2e`
 * where the orchestrator takes name labels, or no one, with why.
 */
export type ApproverIdentity =
  | { kind: 'person'; name: string }
  | { kind: 'label'; name: string }
  | { kind: 'none'; reason: string };

/** An orchestrator GET with the harness's token: the status and the parsed body. */
export type OrchestratorGet = (path: string) => Promise<{ status: number; body: unknown }>;

/**
 * Asks the orchestrator who the harness's token names, before anything is seeded. An
 * orchestrator from before GET /me (404) takes name labels. Throws for a refused token or
 * an answer it can't read.
 */
export async function approverIdentity(get: OrchestratorGet): Promise<ApproverIdentity> {
  const { status, body } = await get('/me');
  if (status === 404) return { kind: 'label', name: E2E_APPROVER_NAME };
  if (status === 401) {
    throw new Error('the orchestrator refused the token (E2E_DASHBOARD_TOKEN, else the API token)');
  }
  if (status !== 200) throw new Error(`GET /me answered ${status}`);
  const session = sessionSchema.safeParse(body);
  if (!session.success) throw new Error('GET /me answered a session this harness cannot read');
  if (session.data.token === 'personal') return { kind: 'person', name: session.data.name };
  if (session.data.canDecide) return { kind: 'label', name: E2E_APPROVER_NAME };
  return {
    kind: 'none',
    reason:
      "the orchestrator has personal dashboard tokens, so the shared API token can't approve. " +
      'Set E2E_DASHBOARD_TOKEN to a token made with `pnpm --filter @page/orchestrator ' +
      'dashboard-token e2e` and listed in its DASHBOARD_TOKENS, or pass --approve manual',
  };
}

/** What the harness's decisions are recorded as. */
export const deciderOf = (identity: { name: string }) => deciderFor(identity.name);

/** The orchestrator's /ui socket, as far as the approver uses it (socket.io-client's). */
export interface ApproverSocket {
  on(event: string, listener: (payload: unknown) => void): unknown;
  emit(event: 'approval.decide', payload: unknown): unknown;
  close(): unknown;
}

export interface ApproverDeps {
  /** Opens the /ui socket with this handshake. socket.io-client connects again on its own. */
  connect(auth: { token: string; name?: string }): ApproverSocket;
  get: OrchestratorGet;
  now(): number;
  log?: (line: string) => void;
}

/**
 * Approves the gated requests of the runs it is told to watch, and only theirs, so on a
 * shared orchestrator it never decides for another issue. A request can arrive before the
 * harness has seen its run, so pending requests are kept until then; each watch and each
 * reconnect also loads the run's requests (GET /approvals?runId=), for those sent while it
 * wasn't listening. Each request is approved once.
 */
export class E2EApprover implements RunApprover {
  private readonly watched = new Set<string>();
  /** Pending requests of runs not watched (yet), by id. */
  private readonly waiting = new Map<string, Approval>();
  /** What it approved, by approval id, in the order it did. */
  private readonly made = new Map<string, E2EApproval>();
  private socket: ApproverSocket | undefined;
  private readonly deps: ApproverDeps;
  private readonly identity: Exclude<ApproverIdentity, { kind: 'none' }>;
  private readonly token: string;
  private readonly log: (line: string) => void;

  /** `token` is the one `identity` came from, sent as `auth.token` on the socket. */
  constructor(
    deps: ApproverDeps,
    identity: Exclude<ApproverIdentity, { kind: 'none' }>,
    token: string,
  ) {
    this.deps = deps;
    this.identity = identity;
    this.token = token;
    this.log = deps.log ?? (() => {});
  }

  /** What its decisions are recorded as, such as `ui:e2e`. */
  get decider(): string {
    return deciderOf(this.identity);
  }

  /** Connects to /ui and starts listening. */
  start(): void {
    const auth =
      this.identity.kind === 'label'
        ? { token: this.token, name: this.identity.name }
        : { token: this.token };
    const socket = this.deps.connect(auth);
    this.socket = socket;
    socket.on('connect', () => {
      for (const runId of this.watched) void this.load(runId);
    });
    socket.on('connect_error', (err) => {
      this.log(`[approve] could not connect to the orchestrator's /ui socket: ${messageOf(err)}`);
    });
    for (const event of ['approval.requested', 'approval.updated'] as const) {
      socket.on(event, (payload) => {
        const parsed = serverToUiEvents[event].safeParse(payload);
        if (parsed.success) this.consider(parsed.data.approval);
        else this.log(`[approve] dropped an ${event} that breaks the contract`);
      });
    }
  }

  /** Approves `runId`'s requests from now on, those already waiting included. */
  watch(runId: string): void {
    if (this.watched.has(runId)) return;
    this.watched.add(runId);
    for (const approval of [...this.waiting.values()]) {
      if (approval.runId === runId) this.consider(approval);
    }
    void this.load(runId);
  }

  /** Stops approving every run it watches, before the reset kills the issue. */
  release(): void {
    this.watched.clear();
  }

  /** The approvals it made for `runIds`, in the order it made them. */
  approvals(runIds: readonly string[]): E2EApproval[] {
    return [...this.made.values()].filter((a) => runIds.includes(a.runId)).map((a) => ({ ...a }));
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
  }

  /** Loads a run's requests, pending and decided. A failed load waits for the next event. */
  private async load(runId: string): Promise<void> {
    try {
      const { status, body } = await this.deps.get(`/approvals?runId=${encodeURIComponent(runId)}`);
      if (status !== 200) throw new Error(`GET /approvals answered ${status}`);
      const list = approvalSchema.array().safeParse(body);
      if (!list.success)
        throw new Error('GET /approvals answered approvals that break the contract');
      for (const approval of list.data) this.consider(approval);
    } catch (err) {
      this.log(`[approve] could not load the requests of run ${runId}: ${messageOf(err)}`);
    }
  }

  /** Approves a pending request of a watched run, once; records how one it made ended. */
  private consider(approval: Approval): void {
    if (approval.decision !== 'pending') {
      this.waiting.delete(approval.id);
      const mine = this.made.get(approval.id);
      if (mine === undefined || mine.decision !== null) return;
      mine.decision = approval.decision;
      mine.decidedBy = approval.decidedBy;
      if (approval.decidedBy !== this.decider) {
        this.log(
          `[approve] ${approval.action} for run ${approval.runId} was ${approval.decision} by ` +
            `${approval.decidedBy} before the harness's approval counted`,
        );
      }
      return;
    }
    if (!this.watched.has(approval.runId)) {
      this.waiting.set(approval.id, approval);
      return;
    }
    this.waiting.delete(approval.id);
    if (this.made.has(approval.id) || this.socket === undefined) return;
    this.socket.emit('approval.decide', { v: 1, approvalId: approval.id, decision: 'approved' });
    this.made.set(approval.id, {
      approvalId: approval.id,
      runId: approval.runId,
      action: approval.action,
      sentAt: new Date(this.deps.now()).toISOString(),
      decision: null,
      decidedBy: null,
    });
    this.log(`[approve] approved ${approval.action} for run ${approval.runId} as ${this.decider}`);
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
