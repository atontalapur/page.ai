import { setTimeout as sleep } from 'node:timers/promises';
import { OpsError, type OpsApi, type OpsReply, type RestartReply } from './ops.ts';

export const OPS_TIMEOUT_MS = 15_000;
// The app answers a restart with 202 and exits half a second later (apps/demo-app/src/ops),
// so a health check right away would reach the old process. scenarios/ops.sh waits the same.
export const RESTART_GRACE_MS = 3_000;
export const HEALTH_TIMEOUT_MS = 90_000;
const HEALTH_POLL_MS = 1_000;

export interface HttpOpsOptions {
  /** The demo app's base URL, such as http://localhost:3000. */
  url: string;
  /** The app's OPS_SECRET. */
  secret: string;
  timeoutMs?: number;
  restartGraceMs?: number;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  fetch?: typeof fetch;
}

/** The ops API over HTTP, with the app's OPS_SECRET as a bearer token. */
export class HttpOps implements OpsApi {
  private readonly options: HttpOpsOptions;
  private readonly base: string;

  constructor(options: HttpOpsOptions) {
    this.options = options;
    this.base = options.url.replace(/\/+$/, '');
  }

  getConfig(signal?: AbortSignal): Promise<OpsReply> {
    return this.request('GET', '/api/ops/config', undefined, signal);
  }

  setConfig(key: string, value: string, signal?: AbortSignal): Promise<OpsReply> {
    return this.request('PUT', configPath(key), { value }, signal);
  }

  deleteConfig(key: string, signal?: AbortSignal): Promise<OpsReply> {
    return this.request('DELETE', configPath(key), undefined, signal);
  }

  async restart(signal?: AbortSignal): Promise<RestartReply> {
    const reply = await this.request('POST', '/api/ops/restart', undefined, signal);
    if (reply.status !== 202) return reply;
    const started = Date.now();
    await sleep(this.options.restartGraceMs ?? RESTART_GRACE_MS, undefined, { signal });
    const ok = await this.waitHealthy(signal);
    return { ...reply, healthy: { ok, afterMs: Date.now() - started } };
  }

  /** Polls /api/health until it answers 200, or HEALTH_TIMEOUT_MS runs out. */
  private async waitHealthy(signal?: AbortSignal): Promise<boolean> {
    const { healthTimeoutMs = HEALTH_TIMEOUT_MS, healthPollMs = HEALTH_POLL_MS } = this.options;
    const doFetch = this.options.fetch ?? fetch;
    const deadline = Date.now() + healthTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const res = await doFetch(`${this.base}/api/health`, {
          signal: this.withTimeout(signal),
        });
        if (res.ok) return true;
      } catch {
        // The old process is gone and the new one isn't listening yet.
        signal?.throwIfAborted();
      }
      await sleep(healthPollMs, undefined, { signal });
    }
    return false;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<OpsReply> {
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.secret}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.withTimeout(signal),
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw new OpsError(`ops API ${method} ${path} failed: ${String(error)}`);
    }
    const text = await res.text().catch(() => '');
    return { status: res.status, body: parseBody(text) };
  }

  private withTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? OPS_TIMEOUT_MS);
    return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  }
}

const configPath = (key: string) => `/api/ops/config/${encodeURIComponent(key)}`;

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
