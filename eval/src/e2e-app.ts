import type { Clock } from './e2e.ts';
import type { ExecResult } from './selftest.ts';

// The demo app an end-to-end test target serves or points at (scripts/e2e-targets.ts):
// waiting for it to come up, and telling when its container never will.

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
