import { jobFixtures } from '@page/contracts/fixtures';
import type { Job } from 'pg-boss';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FakeJobSource } from './fake-job-source.ts';
import { parseFixJob } from './job-source.ts';
import { fixJobWorker } from './pg-boss-source.ts';

const job = jobFixtures.fix;
const logger = pino({ enabled: false });

const bossJob = (id: string, data: unknown): Job<unknown> => ({
  id,
  name: 'fix',
  data,
  expireInSeconds: 900,
  heartbeatSeconds: null,
  retryCount: 1,
  signal: new AbortController().signal,
});

describe('parseFixJob', () => {
  it('reads a fix job whose run id is the job id', () => {
    expect(parseFixJob(job.runId, job)).toEqual({ ok: true, value: job });
  });

  it('refuses a payload that is not a fix job', () => {
    const parsed = parseFixJob(job.runId, { ...job, v: 2 });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/is not a fix job/);
  });

  it('refuses a job whose id is not its run id', () => {
    const parsed = parseFixJob('other', job);
    expect(!parsed.ok && parsed.error).toMatch(/carries runId .*; they must match/);
  });
});

describe('fixJobWorker', () => {
  it('passes a parsed job, its signal and attempt to the handler', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const claimed = bossJob(job.runId, job);
    await fixJobWorker(handler, logger)([claimed]);
    expect(handler).toHaveBeenCalledWith({ job, signal: claimed.signal, attempt: 1 });
  });

  it('throws a malformed job back to pg-boss without running it', async () => {
    const handler = vi.fn(() => Promise.resolve());
    await expect(fixJobWorker(handler, logger)([bossJob(job.runId, {})])).rejects.toThrow(
      /is not a fix job/,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it('lets a handler failure through so pg-boss can retry', async () => {
    const handler = () => Promise.reject(new Error('docker is down'));
    await expect(fixJobWorker(handler, logger)([bossJob(job.runId, job)])).rejects.toThrow(
      'docker is down',
    );
  });
});

describe('FakeJobSource', () => {
  it('delivers jobs to the started handler until stopped', async () => {
    const source = new FakeJobSource();
    const handler = vi.fn(() => Promise.resolve());
    await source.start(handler);
    await source.deliver(job, { attempt: 2 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job, attempt: 2 }));
    await source.stop();
    expect(source.stopped).toBe(true);
    expect(() => source.deliver(job)).toThrow(/not started/);
  });
});
