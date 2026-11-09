import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BugClass, Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { listScenarioIds, loadScenario } from './scenario.ts';
import {
  deriveSplit,
  loadSplit,
  splitIds,
  splitRank,
  type Split,
  type SplitEntry,
} from './split.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCENARIOS = join(ROOT, 'scenarios');

describe('eval/split.json', () => {
  it('puts every scenario in exactly one set, 20 dev and 10 held out', async () => {
    const split = await loadSplit(join(ROOT, 'eval', 'split.json'));
    const ids = await listScenarioIds(SCENARIOS);
    expect([...split.dev, ...split.heldOut].sort()).toEqual(ids);
    expect(new Set([...split.dev, ...split.heldOut]).size).toBe(ids.length);
    expect(split.dev).toHaveLength(20);
    expect(split.heldOut).toHaveLength(10);
  });

  it('is exactly the split the seed derives, so nothing was hand-picked', async () => {
    const split = await loadSplit(join(ROOT, 'eval', 'split.json'));
    const entries: SplitEntry[] = [];
    for (const id of await listScenarioIds(SCENARIOS)) {
      const { meta } = await loadScenario(join(SCENARIOS, id));
      entries.push({ id, class: meta.class, tier: meta.expectedTier });
    }
    const derived = deriveSplit(entries, split.seed, split.heldOut.length);
    expect(split.dev).toEqual(derived.dev);
    expect(split.heldOut).toEqual(derived.heldOut);
    // Even by class: 8, 8, 7 and 7 bugs give 3, 3, 2 and 2 held out.
    const classOf = new Map(entries.map((e) => [e.id, e.class]));
    const perClass: Record<string, number> = {};
    for (const id of split.heldOut)
      perClass[classOf.get(id)!] = (perClass[classOf.get(id)!] ?? 0) + 1;
    expect(perClass).toEqual({ frontend: 3, 'backend-api': 3, database: 2, 'infra-config': 2 });
  });
});

describe('deriveSplit', () => {
  const entry = (id: string, cls: BugClass, tier: Tier): SplitEntry => ({ id, class: cls, tier });
  const ranked = (ids: string[]) =>
    [...ids].sort((a, b) => (splitRank('s', a) < splitRank('s', b) ? -1 : 1));

  it('deals a class share across tiers, lowest first, and takes each stratum by rank', () => {
    const t1 = ['a1', 'a2', 'a3', 'a4'];
    const t2 = ['b1', 'b2'];
    const entries = [
      ...t1.map((id) => entry(id, 'frontend', 1)),
      ...t2.map((id) => entry(id, 'frontend', 2)),
    ];
    const { heldOut, dev } = deriveSplit(entries, 's', 3);
    // Round 1 takes the top of T1 and T2, round 2 the next T1.
    expect(heldOut).toEqual([...ranked(t1).slice(0, 2), ranked(t2)[0]!].sort());
    expect([...dev, ...heldOut].sort()).toEqual([...t1, ...t2].sort());
  });

  it('gives the leftover by largest remainder, ties to the first class', () => {
    const entries = [
      ...['f1', 'f2', 'f3'].map((id) => entry(id, 'frontend', 1)),
      ...['b1', 'b2', 'b3'].map((id) => entry(id, 'backend-api', 1)),
      ...['d1', 'd2'].map((id) => entry(id, 'database', 1)),
    ];
    // Exact shares are 1.5, 1.5 and 1: the spare goes to frontend.
    const { heldOut } = deriveSplit(entries, 's', 4);
    const count = (prefix: string) => heldOut.filter((id) => id.startsWith(prefix)).length;
    expect([count('f'), count('b'), count('d')]).toEqual([2, 1, 1]);
  });

  it('changes when the seed does', () => {
    const entries = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((id) => entry(id, 'database', 1));
    const seeds = ['s', 't', 'u', 'v'].map((seed) => deriveSplit(entries, seed, 2).heldOut.join());
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe('loadSplit', () => {
  const split: Split = { v: 1, seed: 's', method: 'm', dev: ['001-a'], heldOut: ['002-b'] };

  it('reads a split and picks a set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'split-'));
    try {
      await writeFile(join(dir, 'split.json'), JSON.stringify(split));
      const loaded = await loadSplit(join(dir, 'split.json'));
      expect(splitIds(loaded, 'dev')).toEqual(['001-a']);
      expect(splitIds(loaded, 'held-out')).toEqual(['002-b']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a split with unknown fields or an empty set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'split-'));
    try {
      await writeFile(join(dir, 'a.json'), JSON.stringify({ ...split, extra: 1 }));
      await writeFile(join(dir, 'b.json'), JSON.stringify({ ...split, heldOut: [] }));
      await expect(loadSplit(join(dir, 'a.json'))).rejects.toThrow();
      await expect(loadSplit(join(dir, 'b.json'))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
