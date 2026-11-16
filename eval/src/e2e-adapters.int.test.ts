import { randomBytes, randomUUID } from 'node:crypto';
import { loadMigrations } from '@page/db-migrations';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgPipelineReader } from './e2e-adapters.ts';

// The reader's SQL against the orchestrator's real tables, in a throwaway schema. pg-boss
// isn't installed here, so a stand-in `job` table with its key columns takes its place.
const url = process.env.DATABASE_URL ?? 'postgres://page:page@localhost:5432/page';
const schema = `eval_e2e_${randomBytes(4).toString('hex')}`;
const boss = `${schema}_boss`;
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  await pool.query(`create schema ${schema}`);
  for (const migration of await loadMigrations()) await pool.query(migration.sql);
  await pool.query(`create schema ${boss}`);
  await pool.query(`create table ${boss}.job (name text, id uuid, state text)`);
});

afterAll(async () => {
  await pool.query(`drop schema ${schema} cascade`);
  await pool.query(`drop schema ${boss} cascade`);
  await pool.end();
});

describe('PgPipelineReader against Postgres', () => {
  it('reads an issue, its run, steps, approvals and fix job', async () => {
    const reader = new PgPipelineReader(pool, { pgbossSchema: boss });
    const since = await reader.now();
    const runId = randomUUID();
    const {
      rows: [row],
    } = await pool.query<{ id: string }>(
      `insert into issues (fingerprint, title, status, class, severity, current_tier, current_run_id)
       values ('ph-1', 'RangeError: x', 'fixing', 'frontend', 'high', 2, $1) returning id`,
      [runId],
    );
    const issueId = row!.id;
    await pool.query(
      `insert into runs (id, issue_id, tier, status, started_at, pr_url)
       values ($1, $2, 2, 'running', now(), 'https://github.com/o/r/pull/3')`,
      [runId, issueId],
    );
    await pool.query(
      `insert into steps (run_id, seq, kind, input, allowed)
       values ($1, 0, 'exec', 'git status', true), ($1, 1, 'exec', 'pnpm test', true)`,
      [runId],
    );
    await pool.query(`insert into approvals (run_id, action) values ($1, 'ops.restart')`, [runId]);
    await pool.query(`insert into ${boss}.job values ('fix', $1, 'active')`, [runId]);

    const seen = await reader.issuesSeenSince(since);
    expect(seen.map((i) => i.id)).toEqual([issueId]);
    expect(seen[0]).toMatchObject({
      status: 'fixing',
      class: 'frontend',
      currentTier: 2,
      currentRunId: runId,
      occurrences: 1,
    });
    expect(seen[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(since.getTime());
    expect(await reader.issuesSeenSince(new Date(Date.now() + 3_600_000))).toEqual([]);
    expect((await reader.issue(issueId))?.title).toBe('RangeError: x');
    expect(await reader.issue(randomUUID())).toBeNull();

    expect(await reader.run(runId)).toMatchObject({
      run: { id: runId, tier: 2, status: 'running', prUrl: 'https://github.com/o/r/pull/3' },
      jobState: 'active',
      steps: 2,
      pendingApprovals: 1,
    });
    expect(await reader.run(randomUUID())).toMatchObject({
      run: null,
      jobState: null,
      steps: 0,
      pendingApprovals: 0,
    });
  });
});
