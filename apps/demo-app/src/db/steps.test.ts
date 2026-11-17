import { describe, expect, it } from 'vitest';
import { parseSteps } from './steps.ts';

describe('parseSteps', () => {
  it.each([
    [['migrate'], ['migrate']],
    [['seed'], ['seed']],
    [
      ['migrate', 'seed'],
      ['migrate', 'seed'],
    ],
  ])('runs %j in order', (args, steps) => {
    expect(parseSteps(args)).toEqual(steps);
  });

  it('rejects no steps', () => {
    expect(parseSteps([])).toBeUndefined();
  });

  it('rejects an unknown step', () => {
    expect(parseSteps(['migrate', 'reset'])).toBeUndefined();
  });

  // Railway runs the pre-deploy command without a shell, so `&&` and the rest arrive as args.
  it('rejects a command written for a shell', () => {
    expect(parseSteps(['migrate', '&&', 'node', 'scripts/db.ts', 'seed'])).toBeUndefined();
  });
});
