import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
