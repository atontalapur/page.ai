import { ESCALATION_THRESHOLD } from '@page/agent';
import type { Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { evalResultsSchema, type Attempt, type EvalResults } from './results.ts';
import { attempt, results, run } from './test-utils.ts';
import { assertDevOnly, cutCount, NotDevError, renderTune, type Threshold } from './tune.ts';

// Synthetic ids only. None of them is a real scenario, dev or held out.
const DEV = ['dev-a', 'dev-b', 'dev-c'];
const OTHER = 'not-dev-x';

/** A results file with one run per attempt list, checked against the schema. */
const file = (attemptLists: Attempt[][], over: Partial<EvalResults> = {}): EvalResults =>
  evalResultsSchema.parse(
    results(
      'ladder',
      attemptLists.map((attempts, i) =>
        run(DEV[i % DEV.length]!, true, { run: Math.floor(i / DEV.length) + 1, attempts }),
      ),
      over,
    ),
  );

const fix = (tier: Tier, over: Partial<Attempt> = {}) => attempt(tier, over);
const limitHit = (tier: Tier, over: Partial<Attempt> = {}) =>
  attempt(tier, { exitStatus: 'step_limit', checkPassed: false, ...over });

/** The markdown under `### Tier n`, up to the next tier's heading. */
const section = (md: string, tier: Tier) => {
  const start = md.indexOf(`### Tier ${tier}`);
  const end = md.indexOf('### Tier', start + 1);
  return md.slice(start, end === -1 ? undefined : end);
};

const same = (b: { stepLimit: number; costLimitUsd: number; wallTimeLimitMs: number }) =>
  ({ 1: b, 2: b, 3: b }) satisfies Threshold;

/** Fixed limits for the what-if counts, so tuning ESCALATION_THRESHOLD can't move them. */
const WIDE = same({ stepLimit: 40, costLimitUsd: 0.5, wallTimeLimitMs: 14 * 60_000 });

describe('assertDevOnly', () => {
  const clean = file([[fix(1)], [fix(1)]]);

  it('accepts files whose every scenario is a dev one', () => {
    const all = file([[fix(1)]], {
      errors: [{ scenario: 'dev-b', run: 1, tier: 1, message: 'boom' }],
      notPlayed: [{ scenario: 'dev-c', run: 2 }],
      skipped: [{ scenario: 'dev-c', reason: 'ops' }],
    });
    expect(() =>
      assertDevOnly(
        [
          { path: 'a.json', results: clean },
          { path: 'b.json', results: all },
        ],
        DEV,
      ),
    ).not.toThrow();
  });

  const cases: [string, Partial<EvalResults>][] = [
    ['runs', { runs: [run(OTHER, true)] }],
    ['errors', { errors: [{ scenario: OTHER, run: 1, tier: 2, message: 'boom' }] }],
    ['notPlayed', { notPlayed: [{ scenario: OTHER, run: 1 }] }],
    ['skipped', { skipped: [{ scenario: OTHER, reason: 'ops' }] }],
  ];
  it.each(cases)('rejects a non-dev scenario in %s, naming the file', (field, over) => {
    const bad = evalResultsSchema.parse({ ...clean, ...over });
    const files = [
      { path: 'clean.json', results: clean },
      { path: 'bad.json', results: bad },
    ];
    let thrown: unknown;
    try {
      assertDevOnly(files, DEV);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotDevError);
    const err = thrown as NotDevError;
    expect(err.file).toBe('bad.json');
    expect(err.scenario).toBe(OTHER);
    expect(err.message).toContain('bad.json');
    expect(err.message).toContain(OTHER);
    expect(err.message).toContain(field);
  });
});

describe('renderTune counts', () => {
  it('counts exits, fixes and false escalations per tier', () => {
    const md = renderTune([
      file([
        [fix(1), fix(1, { checkPassed: false })],
        [
          limitHit(1, { checkPassed: true }),
          attempt(1, { exitStatus: 'cost_limit', checkPassed: false }),
          attempt(1, { exitStatus: 'time_limit', checkPassed: true }),
          attempt(1, { exitStatus: 'format_errors', checkPassed: true }),
        ],
        [limitHit(2), fix(3)],
      ]),
    ]);
    // attempts, submitted, fixed, step, cost, time, other, false escalations
    expect(section(md, 1)).toContain('| 6 | 2 | 1 | 1 | 1 | 1 | 1 | 2 |');
    expect(section(md, 2)).toContain('| 1 | 0 | 0 | 1 | 0 | 0 | 0 | 0 |');
    expect(section(md, 3)).toContain('| 1 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |');
  });

  it('pools attempts across files and notes incomplete ones', () => {
    const md = renderTune([
      file([[fix(1)]]),
      file([[fix(1)]], { stoppedForBudget: true, notPlayed: [{ scenario: 'dev-b', run: 1 }] }),
    ]);
    expect(md).toContain('Results files: 2 (ladder, ladder). Model: m.');
    expect(md).toContain('Incomplete: ladder stopped for budget; ladder 1 runs not played.');
    expect(section(md, 1)).toContain('| 2 | 2 | 2 |');
  });

  it('refuses no files', () => {
    expect(() => renderTune([])).toThrow('no results files');
  });

  it('refuses results from more than one model', () => {
    const files = [
      results('ladder', [], { model: 'deepseek/deepseek-v4.1-flash' }),
      results('tier1-only', [], { model: 'nvidia/nemotron-3-ultra-550b-a55b:free' }),
    ];
    expect(() => renderTune(files)).toThrow(/results mix models: deepseek.*, nvidia/);
  });
});

describe('renderTune percentiles', () => {
  it('gives p50, p90 and max over fixed attempts only', () => {
    const fixes = Array.from({ length: 10 }, (_, i) =>
      fix(1, { modelCalls: i + 1, costUsd: (i + 1) / 100, durationMs: (i + 1) * 60_000 }),
    );
    // Not fixes, so their much larger usage stays out.
    const misses = [
      limitHit(1, { modelCalls: 40, costUsd: 0.5, durationMs: 840_000 }),
      fix(1, { checkPassed: false, modelCalls: 39, costUsd: 0.49, durationMs: 800_000 }),
    ];
    const md = section(renderTune([file([fixes, misses])]), 1);
    expect(md).toContain('What the fixed attempts used (n = 10):');
    expect(md).toContain('| model calls | 5 | 9 | 10 |');
    expect(md).toContain('| cost | $0.0500 | $0.0900 | $0.1000 |');
    expect(md).toContain('| duration | 300s | 540s | 600s |');
  });

  it('takes a single fix as every percentile', () => {
    const md = section(renderTune([file([[fix(2, { modelCalls: 7 })]])]), 2);
    expect(md).toContain('| model calls | 7 | 7 | 7 |');
  });
});

describe('renderTune what-if', () => {
  it('counts fixes that used more than each candidate', () => {
    const calls = [5, 10, 12, 18, 26, 40];
    const md = section(
      renderTune([file([calls.map((modelCalls) => fix(1, { modelCalls }))])], WIDE),
      1,
    );
    expect(md).toContain('| 10 | 4 of 6 fixes cut |');
    expect(md).toContain('| 15 | 3 of 6 fixes cut |');
    expect(md).toContain('| 20 | 2 of 6 fixes cut |');
    expect(md).toContain('| 25 | 2 of 6 fixes cut |');
    expect(md).toContain('| 30 | 1 of 6 fixes cut |');
    expect(md).toContain('| 35 | 1 of 6 fixes cut |');
    expect(md).toContain('| 40 | 0 of 6 fixes cut |');
  });

  it('does the same for cost and wall time', () => {
    const md = section(
      renderTune(
        [
          file([
            [
              fix(1, { costUsd: 0.04, durationMs: 4 * 60_000 }),
              fix(1, { costUsd: 0.15, durationMs: 9 * 60_000 }),
              fix(1, { costUsd: 0.45, durationMs: 13 * 60_000 }),
            ],
          ]),
        ],
        WIDE,
      ),
      1,
    );
    expect(md).toContain('| $0.05 | 2 of 3 fixes cut |');
    expect(md).toContain('| $0.10 | 2 of 3 fixes cut |');
    expect(md).toContain('| $0.20 | 1 of 3 fixes cut |');
    expect(md).toContain('| $0.30 | 1 of 3 fixes cut |');
    expect(md).toContain('| $0.40 | 1 of 3 fixes cut |');
    expect(md).toContain('| $0.50 | 0 of 3 fixes cut |');
    expect(md).toContain('| 5 min | 2 of 3 fixes cut |');
    expect(md).toContain('| 8 min | 2 of 3 fixes cut |');
    expect(md).toContain('| 10 min | 1 of 3 fixes cut |');
    expect(md).toContain('| 12 min | 1 of 3 fixes cut |');
    expect(md).toContain('| 14 min | 0 of 3 fixes cut |');
  });

  it('cuts only usage strictly above the candidate', () => {
    expect(cutCount([10, 11, 9], 10)).toBe(1);
    expect(cutCount([], 10)).toBe(0);
  });

  it('leaves out candidates above the current limit and says why', () => {
    const threshold = same({ stepLimit: 20, costLimitUsd: 0.1, wallTimeLimitMs: 8 * 60_000 });
    const md = renderTune([file([[fix(1)]])], threshold);
    const tier1 = section(md, 1);
    expect(tier1).toContain('Current limits: 20 model calls, $0.10, 8 min.');
    for (const shown of ['| 10 |', '| 15 |', '| 20 |', '| $0.05 |', '| $0.10 |', '| 5 min |'])
      expect(tier1).toContain(shown);
    for (const hidden of ['| 25 |', '| 40 |', '| $0.20 |', '| $0.50 |', '| 10 min |', '| 14 min |'])
      expect(tier1).not.toContain(hidden);
    expect(md).toContain('can only show what a lower limit would do, not a higher one');
  });

  it('says so when no candidate is at or below the current limit', () => {
    const threshold = same({ stepLimit: 5, costLimitUsd: 0.01, wallTimeLimitMs: 60_000 });
    const tier1 = section(renderTune([file([[fix(1)]])], threshold), 1);
    expect(tier1).toContain('No step limit candidate at or below the current 5.');
    expect(tier1).toContain('No cost limit candidate at or below the current $0.01.');
    expect(tier1).toContain('No time limit candidate at or below the current 1 min.');
  });

  it('reads the current limits from ESCALATION_THRESHOLD by default', () => {
    const files = [file([[fix(1)], [fix(2)], [fix(3)]])];
    const md = renderTune(files);
    expect(md).toBe(renderTune(files, ESCALATION_THRESHOLD));
    for (const tier of [1, 2, 3] as const)
      expect(section(md, tier)).toContain(
        `Current limits: ${ESCALATION_THRESHOLD[tier].stepLimit} model calls`,
      );
  });
});

describe('renderTune empty tiers', () => {
  it('prints no attempts for a tier nobody reached, with no NaN', () => {
    const md = renderTune([file([[fix(1, { modelCalls: 4 })]])]);
    expect(section(md, 2)).toContain('no attempts');
    expect(section(md, 3)).toContain('no attempts');
    expect(section(md, 1)).not.toContain('no attempts');
    expect(md).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('prints no attempts for every tier of a file with no runs', () => {
    const md = renderTune([file([])]);
    for (const tier of [1, 2, 3] as const) expect(section(md, tier)).toContain('no attempts');
    expect(md).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('skips the usage and what-if tables for a tier with no fixes', () => {
    const md = renderTune([file([[limitHit(1)]])]);
    expect(section(md, 1)).toContain('no fixed attempts');
    expect(section(md, 1)).not.toContain('fixes cut');
    expect(md).not.toMatch(/NaN|undefined|Infinity/);
  });
});
