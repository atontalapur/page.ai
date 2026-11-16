// The demo apps the end-to-end test (#14) runs against: `local` (a demo app on this
// machine) and `staging` (the deployed one). Both run the scenario's scripts on the host.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Target } from '../src/e2e.ts';
import type { Scenario } from '../src/scenario.ts';
import { runHost } from './host.ts';

/** The container the local target serves a code scenario from. */
export const LOCAL_CONTAINER = 'page-e2e-demo-app';
const DEMO_IMAGE = 'page-sandbox:demo';

export interface TargetEnv {
  /** The app's base URL, no trailing slash. */
  url: string;
  /** The ops API secret, for ops scenarios. */
  opsSecret: string | undefined;
}

async function run(
  what: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const { code, output } = await runHost(
    command,
    args,
    env,
    signal,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
  if (code !== 0) {
    const tail = output.trim().split('\n').slice(-15).join('\n');
    throw new Error(`${what} exited ${code}${tail === '' ? '' : `:\n${tail}`}`);
  }
  return output;
}

const script = (s: Scenario, name: string) => join(s.dir, name);

/** Runs one of the scenario's host scripts against the app at `app.url`. */
function scenarioScript(s: Scenario, name: string, app: TargetEnv, signal: AbortSignal) {
  const env: NodeJS.ProcessEnv = { DEMO_APP_URL: app.url };
  if (app.opsSecret !== undefined) env.OPS_SECRET = app.opsSecret;
  if (s.kind === 'ops' && app.opsSecret === undefined) {
    throw new Error(`${s.id} is an ops scenario and needs OPS_SECRET`);
  }
  return run(`${s.id}/${name}`, 'sh', [script(s, name)], env, signal);
}

/** Waits for GET /api/health to answer 200, until `signal` (the step's timeout) aborts. */
export async function waitHealthy(url: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await sleep(2000, undefined, { signal });
  }
}

// The scenario is a bad deploy that only the compose stand-in for Railway can play (024).
async function needsCompose(s: Scenario): Promise<boolean> {
  try {
    await access(join(s.dir, 'bad-deploy.patch'));
    return true;
  } catch {
    return false;
  }
}

export interface LocalOptions {
  /** Host port for the code scenario's demo app (E2E_DEMO_APP_PORT, default 3100). */
  port: number;
  /** The demo app's database, as the container reaches it (E2E_DEMO_DATABASE_URL). */
  databaseUrl: string;
  /** The compose demo app, for ops scenarios (DEMO_APP_URL, default localhost:3000). */
  opsApp: TargetEnv;
  /** Skip the image builds and use the page-sandbox:demo already built. */
  build: boolean;
  /**
   * The seed step's limit. The image builds get it instead of runHost's 10 minutes for a
   * script, since a cold build of both images can take longer.
   */
  buildTimeoutMs: number;
}

/**
 * A demo app on this machine.
 *
 * A code scenario builds `page-sandbox:demo` with the scenario's break.sh folded in, the
 * image the node daemon must run with (SANDBOX_IMAGE), and serves the demo app from it with
 * `next dev` in a container of its own. Dev mode because some bugs (001) throw while
 * `next build` prerenders, so no production build of them exists. The container migrates
 * and seeds the compose Postgres's `demo` database first. Unseeding removes it.
 *
 * An ops scenario runs break-ops.sh and fix-ops.sh against the compose demo app.
 */
export function localTarget(options: LocalOptions): Target {
  const codeApp: TargetEnv = {
    url: `http://localhost:${options.port}`,
    opsSecret: options.opsApp.opsSecret,
  };
  const appFor = (s: Scenario) => (s.kind === 'ops' ? options.opsApp : codeApp);
  return {
    name: 'local',
    async seed(s, signal) {
      if (s.kind === 'ops') {
        await scenarioScript(s, 'break-ops.sh', options.opsApp, signal);
        return;
      }
      if (options.build) {
        await run(
          'build page-sandbox',
          'docker',
          ['build', '-q', '-f', 'infra/sandbox/Dockerfile', '-t', 'page-sandbox', '.'],
          {},
          signal,
          options.buildTimeoutMs,
        );
        await run(
          `build ${DEMO_IMAGE}`,
          'docker',
          [
            'build',
            '-q',
            '-f',
            'infra/sandbox/demo.Dockerfile',
            '--build-arg',
            `SCENARIO=${s.id}`,
            '-t',
            DEMO_IMAGE,
            '.',
          ],
          {},
          signal,
          options.buildTimeoutMs,
        );
      }
      await runHost('docker', ['rm', '-f', LOCAL_CONTAINER], {}, signal);
      // Values pass through the environment, so secrets stay out of `ps`.
      await run(
        'start the demo app',
        'docker',
        [
          'run',
          '-d',
          '--name',
          LOCAL_CONTAINER,
          '--add-host',
          'host.docker.internal:host-gateway',
          '-p',
          `${options.port}:3000`,
          '-e',
          'DATABASE_URL',
          '-e',
          'POSTHOG_KEY',
          '-e',
          'POSTHOG_HOST',
          '-e',
          'OPS_SECRET',
          '-e',
          'NEXT_TELEMETRY_DISABLED=1',
          '-w',
          '/workspace/apps/demo-app',
          DEMO_IMAGE,
          'sh',
          '-c',
          'node scripts/db.ts migrate && node scripts/db.ts seed && ' +
            'exec node_modules/.bin/next dev -H 0.0.0.0 -p 3000',
        ],
        { DATABASE_URL: options.databaseUrl },
        signal,
      );
      await waitHealthy(codeApp.url, signal);
    },
    trigger: (s, signal) => scenarioScript(s, 'trigger.sh', appFor(s), signal),
    async unseed(s, signal) {
      if (s.kind === 'ops') {
        await scenarioScript(s, 'fix-ops.sh', options.opsApp, signal);
        return;
      }
      await run('remove the demo app', 'docker', ['rm', '-f', LOCAL_CONTAINER], {}, signal);
    },
  };
}

/**
 * The deployed demo app at DEMO_APP_URL. A code scenario's bug has to be on staging
 * already: it deploys from the seeded demo baseline (infra/sandbox/demo-sync.sh), and the
 * test never redeploys it, so seeding only checks the app is up and unseeding does
 * nothing (the reset closes the agent's PR, so `main` keeps the bug). An ops scenario
 * runs break-ops.sh and fix-ops.sh against it, except a bad deploy, which needs compose.
 */
export function stagingTarget(app: TargetEnv): Target {
  return {
    name: 'staging',
    async seed(s, signal) {
      if (await needsCompose(s)) {
        throw new Error(
          `${s.id} deploys through compose (compose-deploy.sh); run it --target local`,
        );
      }
      await waitHealthy(app.url, signal);
      if (s.kind === 'ops') await scenarioScript(s, 'break-ops.sh', app, signal);
    },
    trigger: (s, signal) => scenarioScript(s, 'trigger.sh', app, signal),
    async unseed(s, signal) {
      if (s.kind === 'ops' && !(await needsCompose(s))) {
        await scenarioScript(s, 'fix-ops.sh', app, signal);
      }
    },
  };
}
