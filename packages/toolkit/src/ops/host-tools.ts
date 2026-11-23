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

export interface OpsHostToolsOptions {
  ops: OpsApi;
  /** Restarts one run may ask for (default MAX_RESTARTS). */
  maxRestarts?: number;
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
}

const fail = (output: string): HostToolOutcome => ({ ok: false, output });

const isOpsTool = (tool: HostToolName) => tool.startsWith('ops.');

/**
 * The Tier 3 ops tools for one run, on the live demo app: read the settings, set or drop a
 * runtime config override, and restart so a change applies. The app's own answer, previews
 * included, goes back to the agent as JSON.
 */
export class OpsHostTools implements HostTools {
  /** Restarts this run has asked for. */
  restarts = 0;
  private readonly options: OpsHostToolsOptions;
  /** Each setting the run changed: its override before the first change (null: none), and now. */
  private readonly changed = new Map<string, { before: string | null; now: string | null }>();
  /** Settings a change was sent for that hasn't answered. */
  private readonly unanswered = new Set<string>();
  /** Whether a restart went out after the run's first change, so the app may serve it. */
  private servesChanges = false;

  constructor(options: OpsHostToolsOptions) {
    this.options = options;
  }

  handles(tool: HostToolName): boolean {
    return isOpsTool(tool);
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    if (!isOpsTool(call.tool)) return fail(`${call.tool} is not an ops tool`);
    if (this.options.refusal !== undefined) return fail(this.options.refusal);
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
      case 'ops.setConfig': {
        const refusal =
          keyRefusal(call.key) ??
          (call.value.length > MAX_SETTING_VALUE
            ? `a setting value is at most ${MAX_SETTING_VALUE} characters`
            : null);
        if (refusal !== null) return fail(refusal);
        const reply = await this.change(call.key, call.value, () =>
          ops.setConfig(call.key, call.value, signal),
        );
        return answered(`PUT /api/ops/config/${call.key}`, reply);
      }
      case 'ops.deleteConfig': {
        const refusal = keyRefusal(call.key);
        if (refusal !== null) return fail(refusal);
        const reply = await this.change(call.key, null, () => ops.deleteConfig(call.key, signal));
        return answered(`DELETE /api/ops/config/${call.key}`, reply);
      }
      case 'ops.restart': {
        const max = this.options.maxRestarts ?? MAX_RESTARTS;
        if (this.restarts >= max) {
          return fail(`this run has restarted the app ${max} times, the most one run may`);
        }
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
   * it changed that the run didn't set back, or a restart after a change, which may serve
   * one the run later took back. A change that never answered isn't counted, since it may
   * not have landed. For a run that submitted, this is the fix it made live.
   */
  get changedApp(): boolean {
    if (this.servesChanges) return true;
    for (const { before, now } of this.changed.values()) if (before !== now) return true;
    return false;
  }

  /**
   * Puts back every override this run changed, and restarts the app if the run restarted it
   * after a change, so the app serves what it served before the run. For a run that ends
   * without a fix: the next run starts from the state this one found. Ignores the run's stop
   * signal and the restart cap, since it runs once the run is over. Best effort: it tries
   * every setting and the restart, and reports what failed rather than rejecting.
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
    return { restored, unknown, restarted, failed };
  }
}

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
