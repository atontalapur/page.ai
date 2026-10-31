import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listScenarioIds, loadScenario, SCENARIO_FILES, ScenarioError } from './scenario.ts';

const meta = {
  class: 'backend-api',
  expectedTier: 1,
  description: 'Cart total skips the last item',
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scenarios-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function scenario(id: string, files: Partial<Record<string, string>> = {}): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir);
  for (const file of SCENARIO_FILES) {
    const body = file in files ? files[file] : file === 'meta.json' ? JSON.stringify(meta) : '';
    if (body === undefined) continue;
    await writeFile(join(dir, file), body);
    if (file.endsWith('.sh')) await chmod(join(dir, file), 0o755);
  }
  return dir;
}

async function problems(dir: string): Promise<string[]> {
  const err: unknown = await loadScenario(dir).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ScenarioError);
  return (err as ScenarioError).problems;
}

describe('loadScenario', () => {
  it('loads a complete scenario', async () => {
    const dir = await scenario('001-cart-total');
    expect(await loadScenario(dir)).toEqual({ id: '001-cart-total', dir, meta });
  });

  it('reports every missing file at once', async () => {
    const dir = await scenario('001-cart-total', { 'check.sh': undefined, 'meta.json': undefined });
    expect(await problems(dir)).toEqual(['missing check.sh', 'missing meta.json']);
  });

  it('requires the scripts to be executable', async () => {
    const dir = await scenario('001-cart-total');
    await chmod(join(dir, 'break.sh'), 0o644);
    expect(await problems(dir)).toEqual(['break.sh is not executable']);
  });

  it('rejects a bad id', async () => {
    const dir = await scenario('cart-total');
    expect((await problems(dir))[0]).toMatch(/^id must match/);
  });

  it('reports schema errors by field', async () => {
    const dir = await scenario('001-cart-total', {
      'meta.json': JSON.stringify({ ...meta, expectedTier: 7 }),
    });
    expect(await problems(dir)).toEqual([expect.stringMatching(/^meta\.json expectedTier: /)]);
  });

  it('reports invalid JSON', async () => {
    const dir = await scenario('001-cart-total', { 'meta.json': '{' });
    expect(await problems(dir)).toEqual([expect.stringMatching(/^meta\.json: /)]);
  });
});

describe('listScenarioIds', () => {
  it('lists directories in order and skips files', async () => {
    await scenario('002-b');
    await scenario('001-a');
    await writeFile(join(root, 'README.md'), '');
    expect(await listScenarioIds(root)).toEqual(['001-a', '002-b']);
  });
});
