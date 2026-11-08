import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { jobFixtures, nodeEnvFixture } from '@page/contracts/fixtures';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { createAdapters, createDaemon } from './daemon.ts';
import { FIX_QUEUE } from './jobs/job-source.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required for integration tests');

// Throwaway schemas for the steps table and pg-boss.
const suffix = randomBytes(4).toString('hex');
const schema = `node_test_${suffix}`;
const bossSchema = `pgboss_node_test_${suffix}`;
const admin = new pg.Pool({ connectionString: url });
const scoped = new URL(url);
scoped.searchParams.set('options', `-c search_path=${schema}`);

afterAll(async () => {
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.query(`drop schema if exists ${bossSchema} cascade`);
  await admin.end();
});

describe('the daemon on real Postgres, with fake Docker, model and socket', () => {
  it('claims a queued fix job and writes its steps to the steps table', async () => {
    // The steps table from toolkit's fixture, until #25 adds it to the orchestrator migrations.
    const steps = await readFile(
      new URL('../../../packages/toolkit/src/audit/__fixtures__/steps.sql', import.meta.url),
      'utf8',
    );
    await admin.query(`create schema ${schema}`);
    await admin.query(`set search_path to ${schema}; ${steps}`);

    const config = loadConfig({
      ...nodeEnvFixture,
      USE_FAKE_ADAPTERS: 'true',
      DATABASE_URL: scoped.href,
      PGBOSS_SCHEMA: bossSchema,
    });
    if (!config.ok) throw new Error(config.error);
    const logger = pino({ enabled: false });
    const adapters = await createAdapters(config.value, logger);

    // The orchestrator's side: create the queue and send a job.
    const boss = new PgBoss({ connectionString: url, schema: bossSchema, supervise: false });
    boss.on('error', () => undefined);
    await boss.start();
    await boss.createQueue(FIX_QUEUE, { policy: 'singleton' });
    const job = jobFixtures.fix;
    await boss.send(FIX_QUEUE, job, { id: job.runId, singletonKey: job.fingerprint });

    const daemon = createDaemon(adapters, logger);
    await daemon.start();
    try {
      await expect
        .poll(async () => (await boss.findJobs(FIX_QUEUE, { id: job.runId }))[0]?.state, {
          timeout: 15_000,
        })
        .toBe('completed');
      const { rows } = await admin.query(
        `select seq, kind, input, exit_code, allowed from ${schema}.steps where run_id = $1`,
        [job.runId],
      );
      expect(rows).toEqual([
        { seq: 0, kind: 'exec', input: 'git status', exit_code: 0, allowed: true },
      ]);
    } finally {
      await daemon.stop();
      await boss.stop({ graceful: false });
    }
  }, 30_000);
});
