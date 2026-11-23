import type { NodeConfig } from '@page/contracts';
import { OpenRouterClient, withRetries, type ModelClient } from '@page/model-client';
import {
  FakeDeployer,
  FakeGitHub,
  FakeOps,
  HttpOps,
  KnowledgeHostTools,
  PostgresAuditSink,
  RailwayDeployer,
  RestGitHub,
  type AuditSink,
  type Deployer,
  type GitHub,
  type OpsApi,
} from '@page/toolkit';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import { nodeName } from './config.ts';
import type { JobSource } from './jobs/job-source.ts';
import { PgBossJobSource } from './jobs/pg-boss-source.ts';
import { FakeLink } from './link/fake-link.ts';
import type { OrchestratorLink } from './link/link.ts';
import { SocketIoLink } from './link/socket-io-link.ts';
import { ScriptedModel } from './model/scripted-model.ts';
import { autoApprovals, LinkApprovals, type Approvals } from './run/approvals.ts';
import { closeChat, RunInbox } from './run/inbox.ts';
import { liveAppLock, type OpsLock } from './run/ops-lock.ts';
import { PgBossRunResults, type RunResults } from './run/results.ts';
import { runFixJob, type RunDeps } from './run/run-fix-job.ts';
import { DockerSandboxes } from './sandbox/docker-sandboxes.ts';
import { FakeSandboxes, fakeWorkspace } from './sandbox/fake-sandboxes.ts';
import { LocalSandboxes } from './sandbox/local-sandboxes.ts';
import type { Sandboxes } from './sandbox/sandbox.ts';

/** Everything the daemon talks to. */
export interface Adapters {
  jobs: JobSource;
  sandboxes: Sandboxes;
  sink: AuditSink;
  link: OrchestratorLink;
  /** The orchestrator's run_finished queue. */
  results: RunResults;
  model: ModelClient;
  /** The demo repo Tier 2 runs push to and open PRs on. */
  github: GitHub;
  /** The live demo app's ops API for Tier 3 runs. Without it, they get no ops tools. */
  ops?: OpsApi;
  /** Claims that live app for one Tier 3 run at a time, across daemons sharing the database. */
  opsLock?: OpsLock;
  /** That app's deploys, for the Tier 3 rollback tool. Without it, runs get no rollback. */
  deployer?: Deployer;
  /**
   * How a run asks a person before a gated ops tool runs. Without it, those calls are
   * refused.
   */
  approvals?: Approvals;
  /** Builds a run's knowledge-graph tools. Without it, runs get none. */
  knowledge?: RunDeps['knowledge'];
  /** Closes connections the adapters opened, after the daemon stops claiming jobs. */
  close(): Promise<void>;
}

export interface Daemon {
  start(): Promise<void>;
  /** Stops claiming, waits for runs in hand, then closes every adapter. */
  stop(): Promise<void>;
}

/**
 * Wires claimed jobs to runFixJob, `run.kill` from the orchestrator to the run it names, and
 * `run.chat` to that run's inbox. A kill for a run this daemon isn't holding is logged and
 * ignored: another node may hold it, or it already finished. A message for one is closed as
 * `run_ended`, since the orchestrator only sends it to the daemon it last heard the run from.
 */
export function createDaemon(adapters: Adapters, logger: Logger): Daemon {
  const {
    jobs,
    sandboxes,
    sink,
    link,
    results,
    model,
    github,
    ops,
    opsLock,
    deployer,
    approvals,
    knowledge,
  } = adapters;
  // Each run's kill switch and inbox, with a logger that carries its issueId, runId and tier.
  const runs = new Map<string, { kill: AbortController; inbox: RunInbox; logger: Logger }>();
  // The link has no `off`, so the handlers go on once however often start() runs.
  let listening = false;
  return {
    async start() {
      // Before claiming, so a stray can't be mistaken for a run in hand.
      const { removed, failed } = await sandboxes.reap();
      if (removed.length > 0) logger.warn({ containers: removed }, 'removed leftover sandboxes');
      for (const { name, error } of failed) {
        logger.error({ container: name, err: error }, 'could not remove a leftover sandbox');
      }
      if (!listening) {
        listening = true;
        link.on('run.kill', ({ runId }) => {
          const run = runs.get(runId);
          if (run === undefined) {
            logger.info({ runId }, 'kill for a run this daemon is not running; ignored');
            return;
          }
          run.logger.info('killing run');
          run.kill.abort();
        });
        link.on('run.chat', (chat) => {
          const run = runs.get(chat.runId);
          if (run !== undefined) return run.inbox.deliver(chat);
          logger.info(
            { runId: chat.runId, chatId: chat.chatId },
            'message for a run this daemon is not running; closed',
          );
          closeChat(link, chat, 'run_ended', logger);
        });
      }
      await jobs.start(async (claimed) => {
        const { issueId, runId, tier } = claimed.job;
        const runLogger = logger.child({ issueId, runId, tier });
        const entry = {
          kill: new AbortController(),
          inbox: new RunInbox({ runId, link, logger: runLogger }),
          logger: runLogger,
        };
        runs.set(runId, entry);
        try {
          await runFixJob(
            claimed,
            {
              sandboxes,
              sink,
              link,
              results,
              model,
              github,
              ...withOps(ops, opsLock, deployer),
              ...(approvals === undefined ? {} : { approvals }),
              ...(knowledge === undefined ? {} : { knowledge }),
              logger,
            },
            entry.kill.signal,
            entry.inbox,
          );
        } finally {
          // runFixJob ends it once the agent stops; this covers a run that never got that far.
          entry.inbox.end('run_ended');
          // A retry of the same runId may have replaced this entry; leave the newer one.
          if (runs.get(runId) === entry) runs.delete(runId);
        }
      });
      logger.info('claiming fix jobs');
    },
    async stop() {
      try {
        await jobs.stop();
      } finally {
        await adapters.close();
      }
    },
  };
}

/**
 * The real adapters for `config`. USE_FAKE_ADAPTERS swaps Docker, OpenRouter, GitHub and
 * the orchestrator socket for fakes. pg-boss (fix jobs in, run results out) and the steps
 * table stay real either way, since they are the local Postgres, not a third party.
 */
export async function createAdapters(config: NodeConfig, logger: Logger): Promise<Adapters> {
  const fake = config.USE_FAKE_ADAPTERS;
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: config.PGBOSS_SCHEMA });
  // pg-boss reports background failures as events; an unhandled 'error' would crash the process.
  boss.on('error', (error) => logger.error({ err: error }, 'pg-boss error'));
  pool.on('error', (error) => logger.error({ err: error }, 'postgres pool error'));
  try {
    await boss.start();
  } catch (error) {
    await pool.end();
    throw error;
  }

  const link = fake
    ? new FakeLink(logger)
    : new SocketIoLink({
        url: config.ORCHESTRATOR_URL,
        secret: config.NODE_SHARED_SECRET,
        name: nodeName(config),
        logger,
      });
  return {
    jobs: new PgBossJobSource({ boss, logger, name: nodeName(config) }),
    sandboxes: sandboxesFor(config),
    sink: new PostgresAuditSink(pool),
    link,
    results: new PgBossRunResults({ boss, logger }),
    model: fake ? new ScriptedModel() : withRetries(openRouter(config)),
    github: fake ? new FakeGitHub() : gitHub(config),
    ...withOps(
      opsFor(config, logger),
      opsLockFor(config, pool, logger),
      deployerFor(config, logger),
    ),
    approvals: approvalsFor(config, link, logger),
    // The orchestrator's knowledge routes, with the secret the link already sends.
    ...(fake
      ? {}
      : {
          knowledge: ({ runId, signal }: { runId: string; signal: AbortSignal }) =>
            new KnowledgeHostTools({
              orchestratorUrl: config.ORCHESTRATOR_URL,
              secret: config.NODE_SHARED_SECRET,
              runId,
              signal,
            }),
        }),
    async close() {
      const results = await Promise.allSettled([
        link.close(),
        boss.stop({ graceful: true }),
        pool.end(),
      ]);
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        throw new AggregateError(
          failed.map((r) => r.reason as unknown),
          'closing the daemon failed',
        );
      }
    },
  };
}

/** Fakes, a container per run, or the one workspace in this container (SANDBOX_RUNTIME). */
export function sandboxesFor(config: NodeConfig): Sandboxes {
  if (config.USE_FAKE_ADAPTERS) return new FakeSandboxes(fakeWorkspace);
  if (config.SANDBOX_RUNTIME === 'local') return new LocalSandboxes();
  return new DockerSandboxes({ image: config.SANDBOX_IMAGE });
}

/**
 * The live demo app's ops API for Tier 3 runs, from OPS_APP_URL and OPS_SECRET, or an
 * in-memory one with fakes on. Without OPS_APP_URL it is undefined, which is logged here,
 * once at startup, rather than on every Tier 3 run.
 */
export function opsFor(config: NodeConfig, logger: Logger): OpsApi | undefined {
  if (config.USE_FAKE_ADAPTERS) return new FakeOps();
  const { OPS_APP_URL: url, OPS_SECRET: secret } = config;
  if (url === undefined) {
    logger.warn('OPS_APP_URL is unset: Tier 3 runs get no ops tools');
    return undefined;
  }
  // The config schema requires a usable OPS_SECRET with OPS_APP_URL.
  if (secret === undefined) throw new Error('OPS_SECRET is required with OPS_APP_URL');
  return new HttpOps({ url, secret });
}

/** The claim on OPS_APP_URL's app for each Tier 3 run. In-memory ops need none. */
export function opsLockFor(config: NodeConfig, pool: pg.Pool, logger: Logger): OpsLock | undefined {
  if (config.USE_FAKE_ADAPTERS || config.OPS_APP_URL === undefined) return undefined;
  return liveAppLock(pool, config.OPS_APP_URL, logger);
}

/**
 * The deploys of OPS_APP_URL's app on Railway, from the OPS_RAILWAY_* vars, for the Tier 3
 * rollback tool, or an in-memory one with fakes on: a live deployment and one before it.
 * Without the vars it is undefined, and a node with an ops API logs that once, here.
 */
export function deployerFor(config: NodeConfig, logger: Logger): Deployer | undefined {
  if (config.USE_FAKE_ADAPTERS) return fakeDeploys();
  const {
    OPS_RAILWAY_TOKEN: token,
    OPS_RAILWAY_PROJECT_ID: projectId,
    OPS_RAILWAY_ENVIRONMENT_ID: environmentId,
    OPS_RAILWAY_SERVICE_ID: serviceId,
  } = config;
  // The config schema takes all four or none, and OPS_APP_URL with them.
  if (
    token === undefined ||
    projectId === undefined ||
    environmentId === undefined ||
    serviceId === undefined
  ) {
    if (config.OPS_APP_URL !== undefined) {
      logger.warn('OPS_RAILWAY_* is unset: Tier 3 runs get no rollback tool');
    }
    return undefined;
  }
  return new RailwayDeployer({ token, projectId, environmentId, serviceId });
}

/**
 * How Tier 3 runs ask a person before a gated ops call: the orchestrator, over `link`, which
 * shows the request on the incident page. AUTO_APPROVE_OPS approves every call instead, and
 * says so once at startup; the config takes it only with fakes or an app on this machine.
 */
export function approvalsFor(
  config: NodeConfig,
  link: OrchestratorLink,
  logger: Logger,
): Approvals {
  if (!config.AUTO_APPROVE_OPS) return new LinkApprovals({ link, logger });
  logger.warn('AUTO_APPROVE_OPS is on: gated ops calls run without asking anyone');
  return autoApprovals('AUTO_APPROVE_OPS');
}

function fakeDeploys(): Deployer {
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  return new FakeDeployer([
    { id: 'fake-live', status: 'SUCCESS', createdAt: at(1), commitSha: null, canRollback: true },
    { id: 'fake-before', status: 'REMOVED', createdAt: at(0), commitSha: null, canRollback: true },
  ]);
}

const withOps = (
  ops: OpsApi | undefined,
  opsLock: OpsLock | undefined,
  deployer: Deployer | undefined,
) => ({
  ...(ops === undefined ? {} : { ops }),
  ...(opsLock === undefined ? {} : { opsLock }),
  ...(deployer === undefined ? {} : { deployer }),
});

function openRouter(config: NodeConfig): ModelClient {
  const { OPENROUTER_API_KEY: apiKey, OPENROUTER_MODEL: model } = config;
  // The config schema requires both unless USE_FAKE_ADAPTERS is set.
  if (apiKey === undefined || model === undefined) {
    throw new Error('OPENROUTER_API_KEY and OPENROUTER_MODEL are required');
  }
  return new OpenRouterClient({ apiKey, model });
}

function gitHub(config: NodeConfig): GitHub {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo } = config;
  // The config schema requires both unless USE_FAKE_ADAPTERS is set.
  if (token === undefined || repo === undefined) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPO are required');
  }
  return new RestGitHub({ token, repo });
}
