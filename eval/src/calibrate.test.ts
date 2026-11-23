import { CONFIDENCE_THRESHOLD } from '@page/agent';
import type { Confidence, Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import {
  candidateRows,
  pickThreshold,
  renderConfidence,
  tierSubmits,
  type ScoredFix,
} from './calibrate.ts';
import type { Attempt } from './results.ts';
import { attempt } from './test-utils.ts';

/** A code fix's score: score 0.8 is tests and checks passing. */
const code = (score: number, over: Partial<Confidence> = {}): Confidence => ({
  score,
  changesCode: true,
  reproduced: false,
  testsPass: score >= 0.5,
  checksPass: false,
  liveAfterChange: null,
  ...over,
});

const ops = (live: boolean): Confidence => ({
  score: live ? 1 : 0,
  changesCode: false,
  reproduced: false,
  testsPass: false,
  checksPass: false,
  liveAfterChange: live,
});

const fixes = (n: number, score: number, passed: boolean): ScoredFix[] =>
  Array.from({ length: n }, () => ({ confidence: code(score), passed }));

const submit = (tier: Tier, confidence: Confidence | null, checkPassed = true): Attempt =>
  attempt(tier, { confidence, checkPassed, lowConfidence: false });

const THRESHOLD_03 = { 1: 0.3, 2: 0.3, 3: 0.3 } as const;

describe('tierSubmits', () => {
  it('splits submits into code fixes, ops-only fixes and unscored ones', () => {
    const split = tierSubmits([
      submit(1, code(0.8)),
      submit(1, code(0, { changesCode: false }), false),
      submit(1, ops(true)),
      submit(1, null),
      attempt(1, { confidence: undefined }),
      attempt(1, { exitStatus: 'step_limit', confidence: null, checkPassed: true }),
    ]);
    expect(split.code.map((f) => [f.confidence.score, f.passed])).toEqual([
      [0.8, true],
      [0, false],
    ]);
    expect(split.opsOnly).toHaveLength(1);
    // A null score and a file from before scoring both count; a limit hit isn't a submit.
    expect(split.unscored).toBe(2);
  });
});

describe('candidateRows', () => {
  it('counts passing and failing fixes strictly under each candidate', () => {
    const rows = candidateRows([
      ...fixes(1, 0, true),
      ...fixes(1, 0.3, true),
      ...fixes(2, 0.3, false),
      ...fixes(1, 0.8, false),
      ...fixes(1, 1, true),
    ]);
    const at = (t: number) => rows.find((r) => r.threshold === t)!;
    // A score at the threshold is not under it, as in isLowConfidence.
    expect(at(0.2)).toMatchObject({ falseEscalations: 1, caught: 0 });
    expect(at(0.3)).toMatchObject({ falseEscalations: 1, caught: 0 });
    expect(at(0.5)).toMatchObject({ falseEscalations: 2, caught: 2 });
    expect(at(0.8)).toMatchObject({ falseEscalations: 2, caught: 2 });
    expect(at(1)).toMatchObject({ falseEscalations: 2, caught: 3 });
    expect(rows.map((r) => r.threshold)).toEqual([0.2, 0.3, 0.5, 0.7, 0.8, 1]);
  });

  it('allows 1 false escalation per 50 passing fixes', () => {
    const allowedAt = (passing: number) =>
      candidateRows([...fixes(1, 0.2, true), ...fixes(passing - 1, 1, true)]).find(
        (r) => r.threshold === 0.3,
      )!.allowed;
    expect(allowedAt(50)).toBe(true);
    expect(allowedAt(49)).toBe(false);
    expect(allowedAt(99)).toBe(true);
  });
});

describe('pickThreshold', () => {
  it('keeps the current value with fewer than 20 code fixes', () => {
    const pick = pickThreshold([...fixes(18, 0.8, true), ...fixes(1, 0, false)], 0.3);
    expect(pick.threshold).toBe(0.3);
    expect(pick.why).toContain('19 scored code fixes, fewer than 20');
  });

  it('picks the allowed candidate that catches the most failing fixes', () => {
    // 100 passing allows 2 false escalations. 0.7 catches the three 0.5s for one false
    // escalation; 0.8 ties it and loses to the lower value; 1.0 escalates the 0.8s.
    const pick = pickThreshold(
      [...fixes(1, 0.5, true), ...fixes(3, 0.5, false), ...fixes(99, 0.8, true)],
      0.3,
    );
    expect(pick).toEqual({
      threshold: 0.7,
      why: 'the allowed candidate that catches the most failing fixes (3), with 1 false escalation',
    });
  });

  it('passes over a candidate that catches more but escalates too many passing fixes', () => {
    // 60 passing allows 1. 0.5 would catch both failing 0.3s but escalate two passing ones.
    const pick = pickThreshold(
      [...fixes(2, 0.3, true), ...fixes(2, 0.3, false), ...fixes(58, 0.8, true)],
      0.3,
    );
    expect(pick.threshold).toBe(0.3);
  });

  it('breaks a tie on caught fixes toward fewer false escalations', () => {
    // Nothing fails, so nothing is caught; 0.3 would escalate the passing 0.2.
    const pick = pickThreshold([...fixes(1, 0.2, true), ...fixes(59, 0.8, true)], 0.3);
    expect(pick.threshold).toBe(0.2);
  });

  it('breaks a full tie toward the current value, then the lower candidate', () => {
    const clean = fixes(30, 1, true);
    expect(pickThreshold(clean, 0.3).threshold).toBe(0.3);
    expect(pickThreshold(clean, 0.8).threshold).toBe(0.8);
    expect(pickThreshold(clean, 0.25).threshold).toBe(0.2);
  });

  it('takes the lowest candidate and flags the scorer when none is allowed', () => {
    const pick = pickThreshold([...fixes(2, 0, true), ...fixes(58, 1, true)], 0.3);
    expect(pick.threshold).toBe(0.2);
    expect(pick.why).toContain('the scorer gives passing fixes a 0');
  });
});

describe('renderConfidence', () => {
  const tier1 = [
    ...Array.from({ length: 24 }, () => submit(1, code(0.8))),
    submit(1, code(0, { changesCode: false }), false),
    attempt(1, { exitStatus: 'time_limit', confidence: null, checkPassed: false }),
    attempt(1, { confidence: code(0.2), checkPassed: true, lowConfidence: true }),
  ];

  it('prints the scores, parts and candidates of a tier, and its pick', () => {
    const md = renderConfidence(tier1, THRESHOLD_03);
    expect(md).toContain('### Tier 1 confidence');
    expect(md).toContain('Scored code fixes: 26 (25 passed, 1 failed).');
    expect(md).toContain(
      "Escalation reasons as played (paged at a config's last tier): budget_exhausted 1, low_confidence 1.",
    );
    expect(md).toContain('| 0 | 0 | 1 |');
    expect(md).toContain('| 0.8 | 24 | 0 |');
    expect(md).toContain('| changes code | 25 | 0 |');
    expect(md).toContain('| tests pass | 24 | 0 |');
    expect(md).toContain('| 0.2 | 0 of 25 | 1 of 1 | yes |');
    expect(md).toContain('| 0.3 | 1 of 25 | 1 of 1 | no |');
    expect(md).toContain(
      'Pick: 0.2, the allowed candidate that catches the most failing fixes (1)',
    );
  });

  it("gives Tier 2 Tier 1's pick and shows ops-only fixes apart", () => {
    const md = renderConfidence(
      [...tier1, submit(2, code(0.8)), submit(3, ops(true)), submit(3, ops(false), false)],
      THRESHOLD_03,
    );
    const tier2 = md.slice(md.indexOf('### Tier 2 confidence'), md.indexOf('### Tier 3'));
    expect(tier2).toContain("Pick: 0.2, Tier 1's pick, since no single-tier config plays Tier 2.");
    const tier3 = md.slice(md.indexOf('### Tier 3 confidence'));
    expect(tier3).toContain('Ops-only fixes: 2.');
    expect(tier3).toContain('| yes (1) | 1 | 0 |');
    expect(tier3).toContain('| no (0) | 0 | 1 |');
    expect(tier3).toContain('Pick: 0.3, 0 scored code fixes, fewer than 20, so it keeps 0.3.');
    expect(md).toContain('Picks: Tier 1 0.2, Tier 2 0.2, Tier 3 0.3.');
  });

  it('prints every tier with no NaN for files with no scores', () => {
    const md = renderConfidence(
      [attempt(1, {}), attempt(3, { confidence: undefined })],
      THRESHOLD_03,
    );
    expect(md).toContain('Unscored submits: 1.');
    expect(md).toContain('Picks: Tier 1 0.3, Tier 2 0.3, Tier 3 0.3.');
    expect(md).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('reads the thresholds it is given', () => {
    expect(renderConfidence([], CONFIDENCE_THRESHOLD)).toContain(
      `Current threshold: ${CONFIDENCE_THRESHOLD[1]}.`,
    );
  });
});
