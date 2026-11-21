// What an eval run of an ops scenario (Tier 3) does on the host, against the live demo app:
// reset and break it before the run, and check it after each attempt.
import { join } from 'node:path';
import { HttpOps, liveAppLockDir, tryLockLiveApp } from '@page/toolkit';
import { checkVerdict, resetOverrides } from '../src/live-app.ts';
import type { Scenario } from '../src/scenario.ts';
import { appEnv, runHost, type LiveApp } from './host.ts';

export const opsApi = (app: LiveApp) => new HttpOps({ url: app.url, secret: app.opsSecret });

/**
 * The runner's prepareRun for ops scenarios: drops every override the last run left, then
 * runs break-ops.sh. Code scenarios need nothing; their sandbox is fresh.
 */
export function prepareOpsRun(app: LiveApp) {
  return async (scenario: Scenario, signal: AbortSignal): Promise<void> => {
    if (scenario.kind !== 'ops') return;
    await resetOverrides(opsApi(app), signal);
    const broke = await runHost('sh', [join(scenario.dir, 'break-ops.sh')], appEnv(app), signal);
    if (broke.code !== 0) throw new Error(`break-ops.sh exited ${broke.code}:\n${broke.output}`);
  };
}

/** check.sh against the live app now, before a later tier can change it. */
export async function checkLive(
  scenario: Scenario,
  app: LiveApp,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runHost('sh', [join(scenario.dir, 'check.sh')], appEnv(app), signal);
  return checkVerdict(result.code, result.output);
}

/**
 * Claims the live app for this process, so two evals, or an eval and a daemon on this
 * machine, can't break and fix it under each other. Returns a release function, or throws
 * naming the lock if another process holds it.
 */
export function lockLiveApp(app: LiveApp): () => void {
  const release = tryLockLiveApp(app.url);
  if (release === null) {
    throw new Error(
      `another eval or daemon run is changing ${app.url}. If none is, remove ` +
        `${liveAppLockDir(app.url)}.`,
    );
  }
  return release;
}
