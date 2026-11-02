import { describe, expect, it, vi } from 'vitest';
import { PostgresAuditSink } from './postgres-sink.ts';
import { TEST_RUN_ID } from './test-utils.ts';

const step = {
  runId: TEST_RUN_ID,
  kind: 'exec' as const,
  input: 'ls',
  outputTrimmed: '',
  exitCode: null,
  allowed: true,
};

describe('PostgresAuditSink', () => {
  it('inserts the step at the next seq for its run and returns that seq', async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1, rows: [{ seq: 3 }] }));
    await expect(new PostgresAuditSink({ query }).open(step)).resolves.toBe(3);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(
        /insert into steps[\s\S]*coalesce\(max\(seq\) \+ 1, 0\)[\s\S]*returning seq/,
      ),
      [TEST_RUN_ID, 'exec', 'ls', '', null, true],
    );
  });

  it('fails when the insert returns no seq', async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 0, rows: [] }));
    await expect(new PostgresAuditSink({ query }).open(step)).rejects.toThrow('returned no seq');
  });

  it('updates the outcome and fails when no step matched', async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1, rows: [] as unknown[] }));
    const sink = new PostgresAuditSink({ query });
    await sink.close(TEST_RUN_ID, 3, { outputTrimmed: 'ok', exitCode: 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('update steps'), [
      TEST_RUN_ID,
      3,
      'ok',
      0,
    ]);
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(sink.close(TEST_RUN_ID, 4, { outputTrimmed: '', exitCode: 0 })).rejects.toThrow(
      'never opened',
    );
  });
});
