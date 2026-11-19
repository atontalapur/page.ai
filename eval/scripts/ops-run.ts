// What an eval run of an ops scenario (Tier 3) does on the host, against the live demo app:
// reset and break it before the run, and check it after each attempt.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpOps } from '@page/toolkit';
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
 * Claims the live app for this process, so two evals can't break and fix it under each
 * other. Resolves a release function, or throws naming the lock if another eval holds it.
 */
export function lockLiveApp(app: LiveApp): () => void {
  const hash = createHash('sha256').update(app.url).digest('hex').slice(0, 12);
  const dir = join(tmpdir(), `page-eval-ops-${hash}.lock`);
  try {
    mkdirSync(dir);
  } catch {
    throw new Error(
      `another eval is playing ops scenarios against ${app.url}. If none is, remove ${dir}.`,
    );
  }
  let held = true;
  const release = () => {
    if (held) rmSync(dir, { recursive: true, force: true });
    held = false;
  };
  process.once('exit', release);
  return release;
}
