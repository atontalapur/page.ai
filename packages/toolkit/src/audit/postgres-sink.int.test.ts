import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../exec/execute.ts';
import { FakeRunner } from '../exec/fake-runner.ts';
import { PostgresAuditSink } from './postgres-sink.ts';
import { StepLog } from './step-log.ts';
import { TEST_ISSUE_ID } from './test-utils.ts';

const url = process.env.DATABASE_URL ?? 'postgres://page:page@localhost:5432/page';
const schema = `toolkit_audit_${randomBytes(4).toString('hex')}`;
let pool: pg.Pool;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 1 });
  await pool.query(`create schema ${schema}`);
  await pool.query(await readFile(new URL('__fixtures__/steps.sql', import.meta.url), 'utf8'));
});

afterAll(async () => {
  await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

interface StepRow {
  run_id: string;
  seq: number;
  kind: string;
  input: string;
  output_trimmed: string;
  exit_code: number | null;
  allowed: boolean;
}

describe('PostgresAuditSink against Postgres', () => {
  const stepsOf = async (runId: string): Promise<StepRow[]> =>
    (
      await pool.query<StepRow>(
        `select run_id, seq, kind, input, output_trimmed, exit_code, allowed
         from steps where run_id = $1 order by seq`,
        [runId],
      )
    ).rows;

  it('writes a refused command and an allowed one as steps rows', async () => {
    const runId = randomUUID();
    const steps = new StepLog({ sink: new PostgresAuditSink(pool), issueId: TEST_ISSUE_ID, runId });
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'src\n'));
    await execute({ kind: 'exec', command: 'sudo rm -rf /' }, { tier: 1, runner, steps });
    await execute({ kind: 'exec', command: 'ls' }, { tier: 1, runner, steps });

    expect(await stepsOf(runId)).toEqual([
      {
        run_id: runId,
        seq: 0,
        kind: 'exec',
        input: 'sudo rm -rf /',
        output_trimmed: 'refused: sudo is blocked at every tier',
        exit_code: null,
        allowed: false,
      },
      {
        run_id: runId,
        seq: 1,
        kind: 'exec',
        input: 'ls',
        output_trimmed: 'src\n',
        exit_code: 0,
        allowed: true,
      },
    ]);
    expect(runner.requests).toHaveLength(1);
  });

  it('carries on from the stored steps when a run resumes', async () => {
    const runId = randomUUID();
    await pool.query(
      `insert into steps (run_id, seq, kind, input, exit_code, allowed)
       values ($1, 0, 'exec', 'ls', 0, true), ($1, 1, 'exec', 'pnpm test', 1, true)`,
      [runId],
    );
    // A fresh StepLog, as after a daemon restart.
    const steps = new StepLog({ sink: new PostgresAuditSink(pool), issueId: TEST_ISSUE_ID, runId });
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'ok\n'));
    const result = await execute(
      { kind: 'exec', command: 'pnpm test' },
      { tier: 1, runner, steps },
    );

    expect(result.ok).toBe(true);
    expect((await stepsOf(runId)).map((row) => [row.seq, row.input])).toEqual([
      [0, 'ls'],
      [1, 'pnpm test'],
      [2, 'pnpm test'],
    ]);
  });

  it('refuses to run when the insert fails', async () => {
    // Its own pool on a schema with no steps table, so the insert fails whatever ran before.
    const broken = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema}_missing`,
      max: 1,
    });
    try {
      const steps = new StepLog({
        sink: new PostgresAuditSink(broken),
        issueId: TEST_ISSUE_ID,
        runId: randomUUID(),
      });
      const runner = new FakeRunner();
      const result = await execute({ kind: 'exec', command: 'ls' }, { tier: 1, runner, steps });
      expect(result).toMatchObject({ ok: false, error: { type: 'audit_failed', ran: false } });
      expect(runner.requests).toEqual([]);
    } finally {
      await broken.end();
    }
  });
});
