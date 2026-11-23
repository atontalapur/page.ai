import { describe, expect, it } from 'vitest';

import { followStep } from './threadMotion';

describe('followStep', () => {
  it('stays put when the view is already at the bottom', () => {
    expect(followStep(0)).toBe(0);
    expect(followStep(0.5)).toBe(0);
  });

  it('eases toward a growing stream instead of jumping the whole gap', () => {
    expect(followStep(100)).toBeCloseTo(28);
    expect(followStep(2)).toBe(1);
  });
});
