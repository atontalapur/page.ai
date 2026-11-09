import type { NodeConfig } from '@page/contracts';
import { OpenRouterClient, withRetries, type ModelClient } from '@page/model-client';
import {
  FakeGitHub,
  PostgresAuditSink,
  RestGitHub,
  type AuditSink,
  type GitHub,
} from '@page/toolkit';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import type { JobSource } from './jobs/job-source.ts';
import { PgBossJobSource } from './jobs/pg-boss-source.ts';
import { FakeLink } from './link/fake-link.ts';
import type { OrchestratorLink } from './link/link.ts';
import { SocketIoLink } from './link/socket-io-link.ts';
import { ScriptedModel } from './model/scripted-model.ts';
import { runFixJob } from './run/run-fix-job.ts';
import { DockerSandboxes } from './sandbox/docker-sandboxes.ts';
import { FakeSandboxes } from './sandbox/fake-sandboxes.ts';
import type { Sandboxes } from './sandbox/sandbox.ts';

/** Everything the daemon talks to. */
export interface Adapters {
  jobs: JobSource;
  sandboxes: Sandboxes;
  sink: AuditSink;
  link: OrchestratorLink;
  model: ModelClient;
  /** The demo repo Tier 2 runs push to and open PRs on. */
  github: GitHub;
  /** Closes connections the adapters opened, after the daemon stops claiming jobs. */
  close(): Promise<void>;
}

export interface Daemon {
  start(): Promise<void>;
  /** Stops claiming, waits for runs in hand, then closes every adapter. */
  stop(): Promise<void>;
}

/**
 * Wires claimed jobs to runFixJob, and `run.kill` from the orchestrator to the run it
 * names. A kill for a run this daemon isn't holding is logged and ignored: another node
 * may hold it, or it already finished.
 */
export function createDaemon(adapters: Adapters, logger: Logger): Daemon {
  const { jobs, sandboxes, sink, link, model, github } = adapters;
  // Each run's kill switch, with a logger that carries the run's issueId, runId and tier.
  const runs = new Map<string, { kill: AbortController; logger: Logger }>();
  // The link has no `off`, so the kill handler goes on once however often start() runs.
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
      }
      await jobs.start(async (claimed) => {
        const { issueId, runId, tier } = claimed.job;
        const entry = {
          kill: new AbortController(),
          logger: logger.child({ issueId, runId, tier }),
        };
        runs.set(runId, entry);
        try {
          await runFixJob(
            claimed,
            { sandboxes, sink, link, model, github, logger },
            entry.kill.signal,
          );
        } finally {
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
 * the orchestrator socket for fakes. pg-boss and the steps table stay real either way, since
 * they are the local Postgres, not a third party.
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
        logger,
      });
  return {
    jobs: new PgBossJobSource({ boss, logger }),
    sandboxes: fake ? new FakeSandboxes() : new DockerSandboxes({ image: config.SANDBOX_IMAGE }),
    sink: new PostgresAuditSink(pool),
    link,
    model: fake ? new ScriptedModel() : withRetries(openRouter(config)),
    github: fake ? new FakeGitHub() : gitHub(config),
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
