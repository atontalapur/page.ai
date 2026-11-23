import { setTimeout as sleep } from 'node:timers/promises';
import type { Deployer, Deployment } from '../deploy/deployer.ts';
import { rollback, ROLLBACK_WINDOW } from '../deploy/rollback.ts';
import type {
  HostToolCall,
  HostToolName,
  HostToolOutcome,
  HostTools,
  OpsToolCall,
} from '../exec/types.ts';
import { OpsError, SETTING_KEY, type OpsApi, type OpsReply, type RestartReply } from './ops.ts';

// A restart drops the live app's requests in flight, so one run gets a few and no more.
export const MAX_RESTARTS = 3;
export const MAX_SETTING_VALUE = 1_000;
// A rollback replaces the whole live build. If one run needs a second, the first was the
// wrong call, and what to deploy next is a person's decision.
export const MAX_ROLLBACKS = 1;
// How often a rollback's wait asks the deployer whether the new deployment is live.
export const ROLLBACK_POLL_MS = 3_000;

// The tools that go to the deployer rather than the app's ops API.
const ROLLBACK_TOOLS: ReadonlySet<HostToolName> = new Set(['ops.planRollback', 'ops.rollback']);
// A deployment in one of these won't go live, so a wait for it is over.
const ENDED: ReadonlySet<string> = new Set(['FAILED', 'CRASHED', 'REMOVED', 'SKIPPED']);

export interface OpsHostToolsOptions {
  ops: OpsApi;
  /**
   * The live app's deploys. With it, the run may plan and send a rollback; without it,
   * ops.planRollback and ops.rollback are not set up.
   */
  deployer?: Deployer;
  /** Restarts one run may ask for (default MAX_RESTARTS). */
  maxRestarts?: number;
  /** Rollbacks one run may send (default MAX_ROLLBACKS). */
  maxRollbacks?: number;
  /** Milliseconds between checks on a rollback's new deployment (default ROLLBACK_POLL_MS). */
  rollbackPollMs?: number;
  /** The run's stop signal. Once it fires, no further ops request goes out. */
  signal?: AbortSignal;
  /** Refuses every ops call with this, sending nothing: for a run that may not use the app. */
  refusal?: string;
}

/** What undo() put back. */
export interface OpsUndo {
  /** Settings whose override is back to what it was before the run. */
  restored: string[];
  /**
   * Settings a change was sent for that never answered, so the change may have landed and
   * the value before it is unknown. undo() leaves them as they are.
   */
  unknown: string[];
  /** Whether undo() restarted the app, because the run had restarted it after a change. */
  restarted: boolean;
  /** What the app refused or never answered: each setting that didn't go back, or the restart. */
  failed: string[];
  /**
   * The rollback the run sent, which undo() leaves as it is (see undo()). Null: the run sent
   * none.
   */
  rollback: SentRollback | null;
}

/** A rollback a run sent: from the deployment live then, to an earlier one. */
export interface SentRollback {
  from: string;
  to: string;
  /** False when the deployer never answered, so the rollback may not have started. */
  accepted: boolean;
}

const fail = (output: string): HostToolOutcome => ({ ok: false, output });

const isOpsTool = (tool: HostToolName) => tool.startsWith('ops.');

/**
 * The Tier 3 ops tools for one run, on the live demo app: read the settings, set or drop a
 * runtime config override, and restart so a change applies. The app's own answer, previews
 * included, goes back to the agent as JSON. With a deployer, the run may also plan a
 * rollback of the app's deploy and then send it, once.
 */
export class OpsHostTools implements HostTools {
  /** Restarts this run has asked for. */
  restarts = 0;
  /** Rollbacks this run has sent to the deployer. */
  rollbacks = 0;
  private readonly options: OpsHostToolsOptions;
  /** Each setting the run changed: its override before the first change (null: none), and now. */
  private readonly changed = new Map<string, { before: string | null; now: string | null }>();
  /** Settings a change was sent for that hasn't answered. */
  private readonly unanswered = new Set<string>();
  /** Whether a restart went out after the run's first change, so the app may serve it. */
  private servesChanges = false;
  /** The run's last rollback plan. ops.rollback must name its target. */
  private plan: { from: Deployment; to: Deployment } | null = null;
  /** The rollback this run sent, if any. */
  private sent: SentRollback | null = null;

  constructor(options: OpsHostToolsOptions) {
    this.options = options;
  }

  handles(tool: HostToolName): boolean {
    if (ROLLBACK_TOOLS.has(tool)) return this.options.deployer !== undefined;
    return isOpsTool(tool);
  }

  /**
   * Why run() would refuse `call` without sending anything, or null: a tool this node lacks,
   * a run refused the app, a bad setting, a spent restart or rollback, or a rollback that
   * isn't the last plan's. execute() asks before a person approves the call.
   */
  refusal(call: HostToolCall): string | null {
    if (!isOpsTool(call.tool)) return `${call.tool} is not an ops tool`;
    if (!this.handles(call.tool)) return `${call.tool} is not set up on this node`;
    if (this.options.refusal !== undefined) return this.options.refusal;
    switch (call.tool) {
      case 'ops.setConfig':
        return (
          keyRefusal(call.key) ??
          (call.value.length > MAX_SETTING_VALUE
            ? `a setting value is at most ${MAX_SETTING_VALUE} characters`
            : null)
        );
      case 'ops.deleteConfig':
        return keyRefusal(call.key);
      case 'ops.restart': {
        const max = this.options.maxRestarts ?? MAX_RESTARTS;
        return this.restarts >= max
          ? `this run has restarted the app ${max} times, the most one run may`
          : null;
      }
      case 'ops.rollback':
        return this.rollbackRefusal(call.to);
      default:
        return null;
    }
  }

  private rollbackRefusal(to: string): string | null {
    const max = this.options.maxRollbacks ?? MAX_ROLLBACKS;
    if (this.rollbacks >= max) {
      return `this run has rolled the app back ${times(max)}, the most one run may`;
    }
    if (this.plan === null) {
      return 'plan the rollback first: ops.planRollback shows what is live and what a rollback would deploy';
    }
    if (this.plan.to.id !== to) {
      return `the last plan goes back to ${this.plan.to.id}, not ${to}; send the target it named`;
    }
    return null;
  }

  /**
   * The rollback the run's last plan named, as the plan showed it: the live deployment and
   * the one ops.rollback would deploy again. Null until a plan succeeds, and once a rollback
   * has been sent for it.
   */
  get plannedRollback(): { live: DeploymentSummary; rollBackTo: DeploymentSummary } | null {
    return this.plan && { live: described(this.plan.from), rollBackTo: described(this.plan.to) };
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    const refusal = this.refusal(call);
    if (refusal !== null) return fail(refusal);
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const { signal: stopped } = this.options;
    const signal = stopped === undefined ? timeout : AbortSignal.any([timeout, stopped]);
    try {
      return await this.dispatch(call as OpsToolCall, signal);
    } catch (error) {
      if (stopped?.aborted) return fail(`${call.tool} stopped: the run was stopped`);
      if (timeout.aborted) return fail(`${call.tool} ran out of time after ${timeoutMs} ms`);
      if (error instanceof OpsError) return fail(error.message);
      throw error;
    }
  }

  private async dispatch(call: OpsToolCall, signal: AbortSignal): Promise<HostToolOutcome> {
    const { ops } = this.options;
    switch (call.tool) {
      case 'ops.getConfig':
        return answered('GET /api/ops/config', await ops.getConfig(signal));
      // run() has checked each call's key, value and limits (refusal()).
      case 'ops.setConfig': {
        const reply = await this.change(call.key, call.value, () =>
          ops.setConfig(call.key, call.value, signal),
        );
        return answered(`PUT /api/ops/config/${call.key}`, reply);
      }
      case 'ops.deleteConfig': {
        const reply = await this.change(call.key, null, () => ops.deleteConfig(call.key, signal));
        return answered(`DELETE /api/ops/config/${call.key}`, reply);
      }
      case 'ops.restart': {
        this.restarts += 1;
        if (this.changed.size > 0 || this.unanswered.size > 0) this.servesChanges = true;
        const reply = await ops.restart(signal);
        const result = answered('POST /api/ops/restart', reply);
        if (reply.healthy === undefined) return result;
        const seconds = Math.round(reply.healthy.afterMs / 1000);
        return reply.healthy.ok
          ? {
              ok: true,
              output: `${result.output}\nThe app is back: /api/health answered after ${seconds}s.`,
            }
          : fail(`${result.output}\nThe app did not answer /api/health within ${seconds}s.`);
      }
      // run() has checked that there is a deployer.
      case 'ops.planRollback':
        return this.planRollback(this.options.deployer!, signal);
      case 'ops.rollback':
        return this.rollBack(this.options.deployer!, call.to, signal);
    }
  }

  /** A dry run: what is live, and what a rollback would deploy. ops.rollback holds to it. */
  private async planRollback(deployer: Deployer, signal: AbortSignal): Promise<HostToolOutcome> {
    this.plan = null;
    const result = await rollback(stoppable(deployer, signal), { dryRun: true });
    if (!result.ok) {
      signal.throwIfAborted();
      return fail(`no rollback: ${result.error.message}`);
    }
    const { from, to } = result.value.plan;
    this.plan = { from, to };
    const plan = { live: described(from), rollBackTo: described(to) };
    return {
      ok: true,
      output:
        `Rollback plan, a dry run: nothing was deployed.\n${JSON.stringify(plan, null, 2)}\n` +
        `ops.rollback to ${to.id} deploys that build again in place of ${from.id}.`,
    };
  }

  /**
   * Sends the rollback the last plan named, if the deployment that plan saw live still is,
   * and waits for the new deployment to go live. The plan is spent once the deployer is
   * asked. A call refused before anything is sent doesn't use up the run's rollback.
   */
  private async rollBack(
    deployer: Deployer,
    to: string,
    signal: AbortSignal,
  ): Promise<HostToolOutcome> {
    // run() has checked the limit and that the plan names `to` (rollbackRefusal).
    const from = this.plan!.from.id;
    this.plan = null;
    const attempt: SentRollback = { from, to, accepted: false };
    const before = this.rollbacks;
    const result = await rollback(
      stoppable(deployer, signal, () => {
        this.sent = attempt;
        this.rollbacks += 1;
      }),
      { dryRun: false, to, from },
    );
    if (!result.ok) {
      if (this.rollbacks > before) {
        return fail(
          `${result.error.message}\nThe rollback may have started. ops.planRollback shows what is live now.`,
        );
      }
      signal.throwIfAborted();
      return fail(`no rollback: ${result.error.message}`);
    }
    attempt.accepted = true;

    const { from: live, to: target } = result.value.plan;
    const head = `Rolled back: ${build(target)} is deploying in place of ${build(live)}.`;
    const wait = await this.waitLive(deployer, live.id, signal);
    const seconds = Math.round(wait.afterMs / 1000);
    switch (wait.state) {
      case 'live':
        return {
          ok: true,
          output: `${head}\nDeployment ${wait.last.id} is live after ${seconds}s.`,
        };
      case 'ended':
        return fail(
          `${head}\nDeployment ${wait.last.id} ended ${wait.last.status} after ${seconds}s, so the rollback is not live. ops.planRollback shows what is live now.`,
        );
      case 'waiting': {
        const seen =
          wait.last === undefined
            ? 'no new deployment has shown up'
            : `deployment ${wait.last.id} is ${wait.last.status}`;
        return fail(`${head}\nIt was not live within ${seconds}s: ${seen}.`);
      }
    }
  }

  /**
   * Waits until the newest deployment after `from`, the one the rollback made, is live or
   * has ended, or until `signal` fires. A deployer that fails to answer is asked again.
   */
  private async waitLive(
    deployer: Deployer,
    from: string,
    signal: AbortSignal,
  ): Promise<
    | { state: 'live' | 'ended'; last: Deployment; afterMs: number }
    | { state: 'waiting'; last: Deployment | undefined; afterMs: number }
  > {
    const started = Date.now();
    const pollMs = this.options.rollbackPollMs ?? ROLLBACK_POLL_MS;
    let last: Deployment | undefined;
    for (;;) {
      try {
        const deployments = await deployer.listDeployments(ROLLBACK_WINDOW);
        if (deployments.findIndex((d) => d.id === from) > 0) last = deployments[0];
      } catch {
        // Asked again on the next turn, until the wait runs out.
      }
      const afterMs = Date.now() - started;
      if (last?.status === 'SUCCESS') return { state: 'live', last, afterMs };
      if (last !== undefined && ENDED.has(last.status)) return { state: 'ended', last, afterMs };
      try {
        await sleep(pollMs, undefined, { signal });
      } catch {
        return { state: 'waiting', last, afterMs: Date.now() - started };
      }
    }
  }

  /**
   * Sends one change and records the override it replaced, from the app's `from`, so undo()
   * can put it back. A change with no answer stays in `unanswered`.
   */
  private async change(
    key: string,
    to: string | null,
    send: () => Promise<OpsReply>,
  ): Promise<OpsReply> {
    this.unanswered.add(key);
    const reply = await send();
    this.unanswered.delete(key);
    const from = changedFrom(reply);
    if (from !== undefined) {
      const first = this.changed.get(key);
      this.changed.set(key, { before: first === undefined ? from : first.before, now: to });
    }
    return reply;
  }

  /**
   * Whether the run has left the live app other than it found it: an override the app says
   * it changed that the run didn't set back, a restart after a change, which may serve one
   * the run later took back, or a rollback the deployer accepted. A change that never
   * answered isn't counted, since it may not have landed. For a run that submitted, this is
   * the fix it made live.
   */
  get changedApp(): boolean {
    if (this.servesChanges || this.sent?.accepted === true) return true;
    for (const { before, now } of this.changed.values()) if (before !== now) return true;
    return false;
  }

  /**
   * Puts back every override this run changed, and restarts the app if the run restarted it
   * after a change, so the app serves what it served before the run. For a run that ends
   * without a fix: the next run starts from the state this one found. Ignores the run's stop
   * signal and the restart cap, since it runs once the run is over. Best effort: it tries
   * every setting and the restart, and reports what failed rather than rejecting.
   *
   * A rollback stays, and is reported in `rollback`. Rolling forward would deploy the build
   * the run judged bad again, with no one deciding to, and it is a deploy of its own that
   * can fail or drop requests. The rollback's target is a build that served traffic before.
   * Once a person approves Tier 3 tools, a roll forward would also undo their decision.
   */
  async undo(): Promise<OpsUndo> {
    const { ops } = this.options;
    const restored: string[] = [];
    const failed: string[] = [];
    const attempt = async (
      what: string,
      send: () => Promise<OpsReply>,
      ok: (r: OpsReply) => boolean,
    ) => {
      try {
        const reply = await send();
        if (ok(reply)) return true;
        failed.push(`${what}: ${describeReply(reply)}`);
      } catch (error) {
        failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    };
    for (const [key, { before, now }] of this.changed) {
      if (before === now && !this.unanswered.has(key)) continue;
      const send = () => (before === null ? ops.deleteConfig(key) : ops.setConfig(key, before));
      if (await attempt(`putting ${key} back`, send, isOk)) {
        this.changed.set(key, { before, now: before });
        this.unanswered.delete(key);
        restored.push(key);
      }
    }
    const unknown = [...this.unanswered].filter((key) => !this.changed.has(key));
    this.unanswered.clear();
    const restarted =
      this.servesChanges &&
      (await attempt(
        'restarting the app',
        () => ops.restart(),
        (r) => r.status === 202 && (r as RestartReply).healthy?.ok === true,
      ));
    if (restarted) this.servesChanges = false;
    return { restored, unknown, restarted, failed, rollback: this.sent && { ...this.sent } };
  }
}

/**
 * `deployer`, sending nothing once `signal` has fired. `onSend` runs as a rollback goes out,
 * so the caller knows one may have started even if the deployer then fails.
 */
function stoppable(deployer: Deployer, signal: AbortSignal, onSend?: () => void): Deployer {
  return {
    listDeployments: (limit) => {
      signal.throwIfAborted();
      return deployer.listDeployments(limit);
    },
    rollbackTo: (id) => {
      signal.throwIfAborted();
      onSend?.();
      return deployer.rollbackTo(id);
    },
  };
}

/** A deployment as a rollback plan shows it to the agent and to the person approving it. */
export interface DeploymentSummary {
  id: string;
  status: string;
  commit: string | null;
  createdAt: string;
}

const described = ({ id, status, commitSha, createdAt }: Deployment): DeploymentSummary => ({
  id,
  status,
  commit: commitSha,
  createdAt,
});

const build = (d: Deployment) => (d.commitSha === null ? d.id : `${d.id} (${d.commitSha})`);

const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** The override a 2xx change replaced (null: none), or undefined if the reply doesn't say. */
function changedFrom(reply: OpsReply): string | null | undefined {
  if (!isOk(reply) || typeof reply.body !== 'object' || reply.body === null) return undefined;
  const { from } = reply.body as { from?: unknown };
  return typeof from === 'string' || from === null ? from : undefined;
}

const isOk = (reply: OpsReply) => reply.status >= 200 && reply.status < 300;

function keyRefusal(key: string): string | null {
  return SETTING_KEY.test(key)
    ? null
    : `${JSON.stringify(key)} is not a setting name; names are UPPER_SNAKE_CASE, as ops.getConfig lists them`;
}

const bodyText = (reply: OpsReply) =>
  typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body, null, 2);

/** The request, the status and the app's answer, ok on any 2xx. */
function answered(request: string, reply: OpsReply): HostToolOutcome {
  return { ok: isOk(reply), output: `${request} answered ${reply.status}\n${bodyText(reply)}` };
}

const describeReply = (reply: OpsReply) => `${reply.status} ${bodyText(reply)}`;
