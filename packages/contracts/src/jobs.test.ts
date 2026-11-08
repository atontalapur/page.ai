import { describe, expect, it } from 'vitest';
import { jobFixtures } from './__fixtures__/index.ts';
import { jobSchemas, type QueueName } from './jobs.ts';
import { roundTrip } from './test-utils.ts';

const queues = Object.keys(jobSchemas) as QueueName[];

describe('jobSchemas', () => {
  it.each(queues)('%s round-trips its fixture', (queue) => {
    expect(roundTrip(jobSchemas[queue], jobFixtures[queue])).toEqual(jobFixtures[queue]);
  });

  it.each(queues)('%s rejects an unknown v', (queue) => {
    expect(() => jobSchemas[queue].parse({ ...jobFixtures[queue], v: 2 })).toThrow();
  });

  it('rejects a fix job without the fingerprint singletonKey', () => {
    const job = { ...jobFixtures.fix, fingerprint: undefined };
    expect(() => jobSchemas.fix.parse(job)).toThrow();
  });

  it('rejects a fix job without a valid tier', () => {
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, tier: undefined })).toThrow();
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, tier: 4 })).toThrow();
  });

  it('accepts a fix job without a report, until triage builds one', () => {
    const job = { ...jobFixtures.fix, report: undefined };
    expect(jobSchemas.fix.parse(job)).toEqual(job);
  });

  it('rejects a blank fix job report', () => {
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, report: '  ' })).toThrow();
  });

  it('rejects an unknown notify channel', () => {
    expect(() => jobSchemas.notify.parse({ ...jobFixtures.notify, channel: 'email' })).toThrow();
  });
});
