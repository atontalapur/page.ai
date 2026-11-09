import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BUG_CLASSES, type BugClass, type Tier } from '@page/contracts';
import { z } from 'zod';

// The dev / held-out split for the 30-bug evaluation (#16). Tuning only ever looks at the
// dev set. Held-out bugs run once, after the escalation threshold is frozen.
export const splitSchema = z.strictObject({
  v: z.literal(1),
  seed: z.string().min(1),
  method: z.string().min(1),
  dev: z.array(z.string()).min(1),
  heldOut: z.array(z.string()).min(1),
});
export type Split = z.infer<typeof splitSchema>;

export type SplitSet = 'dev' | 'held-out';

export async function loadSplit(path: string): Promise<Split> {
  return splitSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

export function splitIds(split: Split, set: SplitSet): string[] {
  return set === 'dev' ? split.dev : split.heldOut;
}

/** The sort key that orders scenarios inside a stratum. */
export function splitRank(seed: string, id: string): string {
  return createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/** What the split needs to know about a scenario. */
export interface SplitEntry {
  id: string;
  class: BugClass;
  tier: Tier;
}

/**
 * The split that `split.json` must equal, so the held-out set follows from the seed alone.
 *
 * 1. Each class gets its share of `heldOutCount` by largest remainder. Ties go to the
 *    class listed first in BUG_CLASSES.
 * 2. Inside a class, the share is dealt one at a time across its tier strata, lowest tier
 *    first, round after round. A stratum that runs out is skipped.
 * 3. Inside a stratum, scenarios are taken in `splitRank` order.
 *
 * Ops scenarios (Tier 3) stay in the split although the runner can't play them yet. A
 * run lists them as skipped.
 */
export function deriveSplit(
  entries: readonly SplitEntry[],
  seed: string,
  heldOutCount: number,
): { dev: string[]; heldOut: string[] } {
  const byRank = (a: SplitEntry, b: SplitEntry) =>
    splitRank(seed, a.id) < splitRank(seed, b.id) ? -1 : 1;
  const classes = BUG_CLASSES.map((cls) => entries.filter((e) => e.class === cls));
  const exact = classes.map((members) => (members.length * heldOutCount) / entries.length);
  const shares = exact.map((x) => Math.floor(x));
  let left = heldOutCount - shares.reduce((n, s) => n + s, 0);
  const byRemainder = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    shares[i]! += 1;
    left -= 1;
  }

  const held = new Set<string>();
  classes.forEach((members, i) => {
    const strata = ([1, 2, 3] as const)
      .map((tier) => members.filter((e) => e.tier === tier).sort(byRank))
      .filter((stratum) => stratum.length > 0);
    let share = Math.min(shares[i]!, members.length);
    for (let round = 0; share > 0; round++) {
      for (const stratum of strata) {
        const next = stratum[round];
        if (share === 0 || next === undefined) continue;
        held.add(next.id);
        share -= 1;
      }
    }
  });

  const ids = entries.map((e) => e.id).sort();
  return { dev: ids.filter((id) => !held.has(id)), heldOut: ids.filter((id) => held.has(id)) };
}
