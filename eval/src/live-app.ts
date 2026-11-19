// The live demo app an ops scenario (Tier 3) breaks and checks, as the eval runner uses it.
import type { OpsApi } from '@page/toolkit';
import { z } from 'zod';
import { BUG_PRESENT } from './selftest.ts';

// GET /api/ops/config (apps/demo-app/src/ops/api.ts): each setting's env value and override.
const configReply = z.object({
  settings: z.array(z.object({ key: z.string(), override: z.string().nullable() })),
});

const describe = (status: number, body: unknown) =>
  `${status} ${typeof body === 'string' ? body : JSON.stringify(body)}`;

/**
 * Drops every runtime config override on the live app and restarts it, so each ops run
 * starts from the app's env settings, whatever an earlier run's agent changed. Resolves the
 * keys it dropped; rejects if any step fails.
 */
export async function resetOverrides(ops: OpsApi, signal?: AbortSignal): Promise<string[]> {
  const config = await ops.getConfig(signal);
  const parsed = configReply.safeParse(config.body);
  if (config.status !== 200 || !parsed.success) {
    throw new Error(`reading the live config failed: ${describe(config.status, config.body)}`);
  }
  const dropped = parsed.data.settings.filter((s) => s.override !== null).map((s) => s.key);
  for (const key of dropped) {
    const reply = await ops.deleteConfig(key, signal);
    if (reply.status !== 200) {
      throw new Error(`dropping the ${key} override failed: ${describe(reply.status, reply.body)}`);
    }
  }
  const restart = await ops.restart(signal);
  if (restart.status !== 202 || restart.healthy?.ok !== true) {
    throw new Error(`restarting the live app failed: ${describe(restart.status, restart.body)}`);
  }
  return dropped;
}

/**
 * check.sh's exit code as a verdict: 0 is fixed and BUG_PRESENT is not. Anything else means
 * the check itself broke, which says nothing about the agent, so it throws.
 */
export function checkVerdict(code: number, output: string): boolean {
  if (code === 0) return true;
  if (code === BUG_PRESENT) return false;
  throw new Error(`check.sh exited ${code}:\n${output.trim()}`);
}
