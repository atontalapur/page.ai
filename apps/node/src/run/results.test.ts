import { jobFixtures } from '@page/contracts/fixtures';
import type { PgBoss } from 'pg-boss';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeRunResults, PgBossRunResults, RUN_FINISHED_QUEUE } from './results.ts';

const job = jobFixtures.run_finished;
const logger = pino({ enabled: false });

/** A pg-boss stand-in whose `send` fails `failures` times before it works. */
function boss(failures: number) {
  const sent: [string, unknown, unknown][] = [];
  let calls = 0;
  const fake = {
    send(name: string, data: unknown, options: unknown) {
      calls += 1;
      if (calls <= failures) return Promise.reject(new Error('connection reset'));
      sent.push([name, data, options]);
      return Promise.resolve('job-id');
    },
  };
  return { boss: fake as unknown as PgBoss, sent, calls: () => calls };
}

describe('PgBossRunResults', () => {
  it('sends the checked result to the run_finished queue under the run id', async () => {
    const b = boss(0);
    await new PgBossRunResults({ boss: b.boss, logger }).send(job);
    expect(b.sent).toEqual([[RUN_FINISHED_QUEUE, job, { id: job.result.runId }]]);
  });

  it('retries a failed send, then gives up and rejects', async () => {
    const flaky = boss(2);
    await new PgBossRunResults({ boss: flaky.boss, logger, retryDelayMs: 1 }).send(job);
    expect(flaky.calls()).toBe(3);
    expect(flaky.sent).toHaveLength(1);

    const down = boss(5);
    const results = new PgBossRunResults({ boss: down.boss, logger, attempts: 2, retryDelayMs: 1 });
    await expect(results.send(job)).rejects.toThrow('connection reset');
    expect(down.calls()).toBe(2);
  });

  it('refuses a result that breaks the contract without sending it', async () => {
    const b = boss(0);
    const bad = { ...job, tier: 4 } as unknown as typeof job;
    await expect(new PgBossRunResults({ boss: b.boss, logger }).send(bad)).rejects.toThrow();
    expect(b.calls()).toBe(0);
  });
});

describe('FakeRunResults', () => {
  it('keeps each checked result', async () => {
    const results = new FakeRunResults();
    await results.send(job);
    expect(results.sent).toEqual([job]);
  });
});
