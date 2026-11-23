import { describe, expect, it } from 'vitest';
import { scenarioInputs, type FrameShape } from './__fixtures__/scenarios.ts';
import { classifyByRules } from './rules.ts';

// The rules over what ingest stores for each of the 30 scenarios. The class table and its
// misses are in eval/README.md (#159). 006 and 014 are Postgres errors whose bug is in the
// route's logic, which nothing in the report shows.
const MISSES = ['006-checkout-stock-recheck', '014-products-sort-param'];

describe.each<FrameShape>(['source', 'compiled'])('the rules on %s frames', (shape) => {
  const scenarios = scenarioInputs(shape);

  it('reads all 30 scenarios', () => {
    expect(scenarios).toHaveLength(30);
  });

  it('gets 016 and 029 right, the two staging classified wrong', () => {
    const verdicts = Object.fromEntries(
      scenarios
        .filter(({ id }) => id.startsWith('016-') || id.startsWith('029-'))
        .map(({ id, input }) => [id, classifyByRules(input).class]),
    );
    expect(verdicts).toEqual({
      '016-product-id-or-slug': 'database',
      '029-shipping-override-out-of-range': 'infra-config',
    });
  });

  it('misses only the scenarios it is known to miss', () => {
    const misses = scenarios
      .filter((scenario) => classifyByRules(scenario.input).class !== scenario.class)
      .map(({ id }) => id);
    expect(misses).toEqual(MISSES);
  });
});
