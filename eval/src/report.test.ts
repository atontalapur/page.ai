import { describe, expect, it } from 'vitest';
import {
  byConfig,
  checkBars,
  loadResultsFile,
  percentile,
  percentileSec,
  renderReport,
  ReportError,
} from './report.ts';
import { attempt, results, run } from './test-utils.ts';

describe('byConfig', () => {
  it('orders configs as the report does', () => {
    const out = byConfig([results('ladder', []), results('tier1-only', [])]);
    expect(out.map((f) => f.config)).toEqual(['tier1-only', 'ladder']);
  });

  it('refuses two files for one config', () => {
    expect(() => byConfig([results('ladder', []), results('ladder', [])])).toThrow(ReportError);
  });

  it('refuses files from different models', () => {
    expect(() =>
      byConfig([results('ladder', []), results('tier1-only', [], { model: 'x' })]),
    ).toThrow(/mix models/);
  });

  it('refuses files that planned different scenarios', () => {
    const dev = results('ladder', [run('001', true)]);
    const heldOut = results('tier1-only', [run('002', true)]);
    expect(() => byConfig([dev, heldOut])).toThrow(/planned different scenarios/);
  });

  it('counts skipped, errored and unplayed scenarios as planned', () => {
    const full = results('ladder', [run('001', true), run('002', true), run('003', true)]);
    const cut = results('tier3-start', [run('001', true)], {
      skipped: [{ scenario: '002', reason: 'ops' }],
      errors: [{ scenario: '003', run: 1, tier: 3, message: 'boom' }],
    });
    expect(byConfig([full, cut])).toHaveLength(2);
  });
});

describe('percentileSec', () => {
  it('uses nearest rank', () => {
    expect(percentileSec([3000, 1000, 2000, 4000], 50)).toBe(2);
    expect(percentileSec([3000, 1000, 2000, 4000], 90)).toBe(4);
    expect(percentileSec([], 50)).toBeNull();
  });
});

describe('checkBars', () => {
  it('passes the ladder bar at 0.8 x tier3-start and misses below it', () => {
    const tier3 = results('tier3-start', [
      run('a', true),
      run('b', true),
      run('c', true),
      run('d', true),
      run('e', true),
    ]);
    const pass = checkBars([
      tier3,
      results('ladder', [
        run('a', true),
        run('b', true),
        run('c', true),
        run('d', true),
        run('e', false),
      ]),
    ]);
    expect(pass[0]?.pass).toBe(true);
    const miss = checkBars([
      tier3,
      results('ladder', [
        run('a', true),
        run('b', true),
        run('c', true),
        run('d', false),
        run('e', false),
      ]),
    ]);
    expect(miss[0]?.pass).toBe(false);
  });

  it('scores the ladder bar only on bugs both configs played', () => {
    // tier3-start's run of b errored, so b is left out and the ladder's miss on it too.
    const tier3 = results('tier3-start', [run('a', true)], {
      errors: [{ scenario: 'b', run: 1, tier: 3, message: 'sandbox' }],
    });
    const ladder = results('ladder', [run('a', true), run('b', false)]);
    expect(checkBars([tier3, ladder])[0]).toMatchObject({ value: '1.00 x, on 1 bugs', pass: true });
  });

  it('leaves the ladder bar unscored when tier3-start fixed nothing', () => {
    const bars = checkBars([
      results('tier3-start', [run('a', false)]),
      results('ladder', [run('a', true)]),
    ]);
    expect(bars[0]).toMatchObject({ value: 'n/a', pass: null });
  });

  it('scores tier1-only only on Tier 1 bugs', () => {
    const bars = checkBars([
      results('tier1-only', [
        run('a', true),
        run('b', false, { expectedTier: 3 }),
        run('c', false, { expectedTier: 2 }),
      ]),
    ]);
    expect(bars[1]).toMatchObject({ value: '1.00 (1/1)', pass: true });
    expect(bars[0]?.pass).toBeNull();
  });

  it('counts runs with a model_error attempt', () => {
    const bad = run('a', false, {
      attempts: [attempt(1, { exitStatus: 'model_error', checkPassed: false })],
    });
    expect(checkBars([results('tier1-only', [bad])])[2]).toMatchObject({ value: '1', pass: false });
  });
});

describe('renderReport', () => {
  it('lists bugs where the ladder fixed fewer runs than tier3-start', () => {
    const lost = run('009', false, {
      attempts: [
        attempt(1, { exitStatus: 'step_limit' }),
        attempt(2, { exitStatus: 'cost_limit' }),
        attempt(3, { exitStatus: 'time_limit' }),
      ],
    });
    const md = renderReport([
      results('tier3-start', [run('009', true, { tierLanded: 3 }), run('015', true)]),
      results('ladder', [lost, run('015', true)]),
    ]);
    expect(md).toContain('| 009 | 0.00 (0/1) | 1.00 (1/1) | T3 time_limit |');
    expect(md).not.toContain('| 015 |');
  });

  it('compares fix rates, not counts, when tier3-start ran fewer times', () => {
    const md = renderReport([
      results('tier3-start', [run('009', true)], { runsPerScenario: 1 }),
      results(
        'ladder',
        [run('009', true), run('009', false, { run: 2 }), run('009', false, { run: 3 })],
        {
          runsPerScenario: 3,
        },
      ),
    ]);
    expect(md).toContain('| 009 | 0.33 (1/3) | 1.00 (1/1) | T1 step_limit, T1 step_limit |');
    expect(md).toMatch(/\| tier3-start \| 1 \|/);
    expect(md).toMatch(/\| ladder \| 3 \|/);
  });

  it('says so when the ladder kept up on every bug', () => {
    const md = renderReport([
      results('tier3-start', [run('a', true)]),
      results('ladder', [run('a', true)]),
    ]);
    expect(md).toContain('at least as large a share as tier3-start on every bug');
  });

  it('flags results the budget or provider cut short, and skipped scenarios', () => {
    const md = renderReport([
      results('ladder', [run('a', true)], {
        stoppedForBudget: true,
        stoppedForProvider: true,
        notPlayed: [{ scenario: 'a', run: 2 }],
        skipped: [{ scenario: 'b', reason: 'ops' }],
      }),
    ]);
    expect(md).toContain(
      'Incomplete: ladder stopped for budget; ladder stopped for a provider error; ladder 1 runs not played; ladder 1 scenarios skipped.',
    );
  });

  it('lists every day a config started on', () => {
    const md = renderReport([
      results('tier1-only', [run('a', true)]),
      results('ladder', [run('a', true)], { startedAt: '2026-11-11T09:00:00.000Z' }),
    ]);
    expect(md).toContain('Played 2026-11-10, 2026-11-11.');
  });

  it('prices kept runs apart from everything spent', () => {
    const md = renderReport([
      results('ladder', [run('a', true, { costUsd: 0.02 }), run('b', true, { costUsd: 0.02 })], {
        spentUsd: 0.1,
      }),
    ]);
    expect(md).toContain('| ladder | 1 | 1.00 (2/2) | $0.0400 | $0.0200 | $0.1000 |');
  });

  it('refuses an empty set', () => {
    expect(() => renderReport([])).toThrow(ReportError);
  });
});

describe('loadResultsFile', () => {
  it('names the file that failed to load', async () => {
    const failed = loadResultsFile('/nonexistent/eval-results.json');
    await expect(failed).rejects.toBeInstanceOf(ReportError);
    await expect(failed).rejects.toThrow(/^\/nonexistent\/eval-results\.json: /);
  });
});

describe('percentile', () => {
  it('takes the nearest rank, unrounded', () => {
    expect(percentile([0.3, 0.1, 0.2], 50)).toBe(0.2);
    expect(percentile([0.3, 0.1, 0.2], 100)).toBe(0.3);
    expect(percentile([], 50)).toBeNull();
  });
});
