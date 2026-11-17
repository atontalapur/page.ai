import type { Clock } from './e2e.ts';
import type { ExecResult } from './selftest.ts';

// The demo app an end-to-end test target serves or points at (scripts/e2e-targets.ts):
// where the local one is, waiting for it to come up, and telling when its container never
// will.

export interface HealthOptions {
  clock: Clock;
  /** Between tries (default 2 s). */
  pollMs?: number;
  /**
   * Why the app can never answer, such as its container having exited, or null while it
   * still might. Asked after every try that didn't get a 200.
   */
  gone?: () => Promise<string | null>;
  fetch?: typeof fetch;
}

// One try waits this long for an answer before the next.
const TRY_MS = 10_000;

/**
 * Waits for GET /api/health to answer 200, until `signal` (the step's timeout) aborts.
 * Fails at once when `gone` gives a reason.
 */
export async function waitHealthy(
  url: string,
  signal: AbortSignal,
  { clock, pollMs = 2000, gone, fetch: doFetch = fetch }: HealthOptions,
): Promise<void> {
  for (;;) {
    try {
      const res = await doFetch(`${url}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRY_MS)]),
      });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    const reason = await gone?.();
    if (reason) throw new Error(reason);
    await clock.sleep(pollMs, signal);
  }
}

/**
 * Why a container can't serve, from `docker inspect -f '{{.State.Status}}
 * {{.State.ExitCode}}'`, or null while it is still up or starting.
 */
export function containerStopped(name: string, { code, output }: ExecResult): string | null {
  const text = output.trim();
  if (code !== 0) return `container ${name} is gone: ${text}`;
  const [status, exitCode] = text.split(/\s+/);
  if (status !== 'exited' && status !== 'dead') return null;
  return `container ${name} ${status} with code ${exitCode ?? '?'} before /api/health answered`;
}

const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The compose demo app the local target plays ops scenarios against: E2E_LOCAL_APP_URL,
 * else localhost on DEMO_APP_PORT (default 3000), where docker-compose.yml publishes it.
 * Throws for a host off this machine, so a local run can't break a deployed app: the
 * DEMO_APP_URL in .env is staging's.
 */
export function localAppUrl(env: Record<string, string | undefined>): string {
  let raw = env.E2E_LOCAL_APP_URL?.trim();
  if (!raw) {
    const port = env.DEMO_APP_PORT?.trim() || '3000';
    if (!/^\d+$/.test(port)) throw new Error(`DEMO_APP_PORT must be a port number, not ${port}`);
    raw = `http://localhost:${port}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`E2E_LOCAL_APP_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`E2E_LOCAL_APP_URL must be an http(s) URL, not ${raw}`);
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(
      `E2E_LOCAL_APP_URL must be on this machine (localhost, 127.0.0.1 or ::1), not ` +
        `${url.hostname}: --target local never runs a scenario against a deployed app`,
    );
  }
  return raw.replace(/\/+$/, '');
}
