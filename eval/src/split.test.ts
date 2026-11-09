import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listScenarioIds, loadScenario } from './scenario.ts';
import { loadSplit, splitIds, splitRank, type Split } from './split.ts';

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

  it('holds out the first scenarios of each class and tier by seeded rank', async () => {
    const split = await loadSplit(join(ROOT, 'eval', 'split.json'));
    const held = new Set(split.heldOut);
    const strata = new Map<string, string[]>();
    for (const id of await listScenarioIds(SCENARIOS)) {
      const { meta } = await loadScenario(join(SCENARIOS, id));
      const key = `${meta.class} tier ${meta.expectedTier}`;
      strata.set(key, [...(strata.get(key) ?? []), id]);
    }
    const perClass = new Map<string, number>();
    for (const [key, ids] of strata) {
      ids.sort((a, b) => (splitRank(split.seed, a) < splitRank(split.seed, b) ? -1 : 1));
      const n = ids.filter((id) => held.has(id)).length;
      // No cherry-picking: the held-out ones are a prefix of the ranked stratum.
      expect(
        ids.slice(0, n).every((id) => held.has(id)),
        key,
      ).toBe(true);
      const cls = key.split(' ')[0]!;
      perClass.set(cls, (perClass.get(cls) ?? 0) + n);
    }
    // Even by class: 8, 8, 7 and 7 bugs give 3, 3, 2 and 2 held out.
    expect(Object.fromEntries(perClass)).toEqual({
      frontend: 3,
      'backend-api': 3,
      database: 2,
      'infra-config': 2,
    });
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
