import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '../exec/execute.ts';
import { FakeRunner } from '../exec/fake-runner.ts';
import { PostgresAuditSink } from './postgres-sink.ts';
import { StepLog } from './step-log.ts';
import { TEST_ISSUE_ID, TEST_RUN_ID } from './test-utils.ts';

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

describe('PostgresAuditSink against Postgres', () => {
  it('writes a refused command and an allowed one as steps rows', async () => {
    const steps = new StepLog({
      sink: new PostgresAuditSink(pool),
      issueId: TEST_ISSUE_ID,
      runId: TEST_RUN_ID,
    });
    const runner = new FakeRunner(() => FakeRunner.exited(0, 'src\n'));
    await execute({ kind: 'exec', command: 'sudo rm -rf /' }, { tier: 1, runner, steps });
    await execute({ kind: 'exec', command: 'ls' }, { tier: 1, runner, steps });

    const { rows } = await pool.query(
      'select run_id, seq, kind, input, output_trimmed, exit_code, allowed from steps order by seq',
    );
    expect(rows).toEqual([
      {
        run_id: TEST_RUN_ID,
        seq: 0,
        kind: 'exec',
        input: 'sudo rm -rf /',
        output_trimmed: 'refused: sudo is blocked at every tier',
        exit_code: null,
        allowed: false,
      },
      {
        run_id: TEST_RUN_ID,
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

  it('refuses to run when the insert fails (seq already taken)', async () => {
    const steps = new StepLog({
      sink: new PostgresAuditSink(pool),
      issueId: TEST_ISSUE_ID,
      runId: TEST_RUN_ID,
    });
    const runner = new FakeRunner();
    const result = await execute({ kind: 'exec', command: 'ls' }, { tier: 1, runner, steps });
    expect(result).toMatchObject({ ok: false, error: { type: 'audit_failed', ran: false } });
    expect(runner.requests).toEqual([]);
  });
});
