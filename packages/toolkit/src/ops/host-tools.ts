import type {
  HostToolCall,
  HostToolName,
  HostToolOutcome,
  HostTools,
  OpsToolCall,
} from '../exec/types.ts';
import { OpsError, SETTING_KEY, type OpsApi, type OpsReply } from './ops.ts';

// A restart drops the live app's requests in flight, so one run gets a few and no more.
export const MAX_RESTARTS = 3;
export const MAX_SETTING_VALUE = 1_000;

export interface OpsHostToolsOptions {
  ops: OpsApi;
  /** Restarts one run may ask for (default MAX_RESTARTS). */
  maxRestarts?: number;
  /** The run's stop signal. Once it fires, no further ops request goes out. */
  signal?: AbortSignal;
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

  constructor(options: OpsHostToolsOptions) {
    this.options = options;
  }

  handles(tool: HostToolName): boolean {
    return isOpsTool(tool);
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    if (!isOpsTool(call.tool)) return fail(`${call.tool} is not an ops tool`);
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
        const reply = await ops.setConfig(call.key, call.value, signal);
        return answered(`PUT /api/ops/config/${call.key}`, reply);
      }
      case 'ops.deleteConfig': {
        const refusal = keyRefusal(call.key);
        if (refusal !== null) return fail(refusal);
        return answered(
          `DELETE /api/ops/config/${call.key}`,
          await ops.deleteConfig(call.key, signal),
        );
      }
      case 'ops.restart': {
        const max = this.options.maxRestarts ?? MAX_RESTARTS;
        if (this.restarts >= max) {
          return fail(`this run has restarted the app ${max} times, the most one run may`);
        }
        this.restarts += 1;
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
}

function keyRefusal(key: string): string | null {
  return SETTING_KEY.test(key)
    ? null
    : `${JSON.stringify(key)} is not a setting name; names are UPPER_SNAKE_CASE, as ops.getConfig lists them`;
}

/** The request, the status and the app's answer, ok on any 2xx. */
function answered(request: string, reply: OpsReply): HostToolOutcome {
  const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body, null, 2);
  return {
    ok: reply.status >= 200 && reply.status < 300,
    output: `${request} answered ${reply.status}\n${body}`,
  };
}
