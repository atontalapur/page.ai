import { describe, expect, it } from 'vitest';
import { escalationNoteFixture, jobFixtures } from './__fixtures__/index.ts';
import { jobSchemas, MAX_RUN_DIFF_CHARS, type QueueName } from './jobs.ts';
import { roundTrip } from './test-utils.ts';

const queues = Object.keys(jobSchemas) as QueueName[];

describe('jobSchemas', () => {
  it.each(queues)('%s round-trips its fixture', (queue) => {
    expect(roundTrip(jobSchemas[queue], jobFixtures[queue])).toEqual(jobFixtures[queue]);
  });

  it.each(queues)('%s rejects an unknown v', (queue) => {
    const v = jobFixtures[queue].v + 1;
    expect(() => jobSchemas[queue].parse({ ...jobFixtures[queue], v })).toThrow();
  });

  it('rejects a fix job without the fingerprint singletonKey', () => {
    const job = { ...jobFixtures.fix, fingerprint: undefined };
    expect(() => jobSchemas.fix.parse(job)).toThrow();
  });

  it('rejects a fix job without a valid tier', () => {
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, tier: undefined })).toThrow();
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, tier: 4 })).toThrow();
  });

  it('accepts a fix job without a report, which the daemon then fails', () => {
    const job = { ...jobFixtures.fix, report: undefined };
    expect(jobSchemas.fix.parse(job)).toEqual(job);
  });

  it('rejects a blank fix job report', () => {
    expect(() => jobSchemas.fix.parse({ ...jobFixtures.fix, report: '  ' })).toThrow();
  });

  it('carries the escalation note from the tier below, and rejects a bad one', () => {
    const job = { ...jobFixtures.fix, tier: 2, escalationNote: escalationNoteFixture };
    expect(roundTrip(jobSchemas.fix, job)).toEqual(job);
    const bad = { ...job, escalationNote: { ...escalationNoteFixture, blocker: '' } };
    expect(() => jobSchemas.fix.parse(bad)).toThrow();
  });

  describe('run_finished', () => {
    const escalated = {
      ...jobFixtures.run_finished,
      diff: null,
      result: {
        ...jobFixtures.run_finished.result,
        status: 'escalated',
        reason: 'budget_exhausted',
        toTier: 2,
        note: escalationNoteFixture,
      },
    };

    it('round-trips an escalation to the tier above', () => {
      expect(roundTrip(jobSchemas.run_finished, escalated)).toEqual(escalated);
    });

    it('rejects an escalation that does not go up a tier', () => {
      const flat = { ...escalated, tier: 2 };
      expect(() => jobSchemas.run_finished.parse(flat)).toThrow(/above the run tier/);
    });

    it('rejects a diff over the cap', () => {
      const job = { ...jobFixtures.run_finished, diff: 'x'.repeat(MAX_RUN_DIFF_CHARS + 1) };
      expect(() => jobSchemas.run_finished.parse(job)).toThrow();
    });

    it('rejects a result that breaks the node.run.finished contract', () => {
      const job = {
        ...jobFixtures.run_finished,
        result: { ...jobFixtures.run_finished.result, prUrl: 'javascript:alert(1)' },
      };
      expect(() => jobSchemas.run_finished.parse(job)).toThrow();
    });
  });

  it('rejects an unknown notify channel', () => {
    expect(() => jobSchemas.notify.parse({ ...jobFixtures.notify, channel: 'email' })).toThrow();
  });
});
