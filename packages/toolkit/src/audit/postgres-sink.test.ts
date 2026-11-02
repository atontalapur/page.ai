import { describe, expect, it, vi } from 'vitest';
import { PostgresAuditSink } from './postgres-sink.ts';
import { TEST_RUN_ID } from './test-utils.ts';

const entry = {
  runId: TEST_RUN_ID,
  seq: 3,
  kind: 'exec' as const,
  input: 'ls',
  outputTrimmed: '',
  exitCode: null,
  allowed: true,
};

describe('PostgresAuditSink', () => {
  it('inserts the step with every column', async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1 }));
    await new PostgresAuditSink({ query }).open(entry);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('insert into steps'), [
      TEST_RUN_ID,
      3,
      'exec',
      'ls',
      '',
      null,
      true,
    ]);
  });

  it('updates the outcome and fails when no step matched', async () => {
    const query = vi.fn(() => Promise.resolve({ rowCount: 1 }));
    const sink = new PostgresAuditSink({ query });
    await sink.close(TEST_RUN_ID, 3, { outputTrimmed: 'ok', exitCode: 0 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('update steps'), [
      TEST_RUN_ID,
      3,
      'ok',
      0,
    ]);
    query.mockResolvedValueOnce({ rowCount: 0 });
    await expect(sink.close(TEST_RUN_ID, 4, { outputTrimmed: '', exitCode: 0 })).rejects.toThrow(
      'never opened',
    );
  });
});
