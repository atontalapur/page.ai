import { describe, expect, it } from 'vitest';
import { escalationNoteFixture, jobFixtures } from './__fixtures__/index.ts';
import {
  FIX_QUEUE,
  jobSchemas,
  MAX_RUN_DIFF_CHARS,
  NOTIFY_QUEUE,
  RUN_FINISHED_QUEUE,
  TRIAGE_QUEUE,
  type QueueName,
} from './jobs.ts';
import { roundTrip } from './test-utils.ts';

const queues = Object.keys(jobSchemas) as QueueName[];

describe('jobSchemas', () => {
  it('has a name constant for every queue', () => {
    expect([TRIAGE_QUEUE, FIX_QUEUE, NOTIFY_QUEUE, RUN_FINISHED_QUEUE].sort()).toEqual(
      [...queues].sort(),
    );
  });

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
    const { runId } = jobFixtures.run_finished.result;
    const escalated = {
      ...jobFixtures.run_finished,
      diff: null,
      result: {
        v: 1,
        runId,
        prUrl: null,
        confidence: null,
        status: 'escalated',
        reason: 'budget_exhausted',
        toTier: 2,
        note: escalationNoteFixture,
      },
    };
    // A Tier 3 run that fixed the live app through the ops API and changed no code.
    const opsOnly = {
      ...jobFixtures.run_finished,
      tier: 3,
      diff: '',
      result: { ...jobFixtures.run_finished.result, opsOnly: true },
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

    it('round-trips an ops-only success, with an empty diff or none', () => {
      expect(roundTrip(jobSchemas.run_finished, opsOnly)).toEqual(opsOnly);
      const noDiff = { ...opsOnly, diff: null };
      expect(roundTrip(jobSchemas.run_finished, noDiff)).toEqual(noDiff);
    });

    it('reads a success without opsOnly, from an older daemon, as not ops-only', () => {
      const old = {
        ...jobFixtures.run_finished,
        result: { v: 1, runId, status: 'succeeded', prUrl: null, confidence: null, note: null },
      };
      expect(jobSchemas.run_finished.parse(old).result).toMatchObject({ opsOnly: false });
    });

    it.each([
      ['below Tier 3', { tier: 2 }],
      ['with a diff', { diff: '--- a/x\n+++ b/x\n' }],
      [
        'with a PR',
        {
          result: {
            ...opsOnly.result,
            prUrl: 'https://github.com/atontalapur/page-demo/pull/7',
          },
        },
      ],
    ])('rejects an ops-only success %s', (_, change) => {
      expect(() => jobSchemas.run_finished.parse({ ...opsOnly, ...change })).toThrow(
        /no PR and no diff/,
      );
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
