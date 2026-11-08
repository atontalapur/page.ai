import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listScenarioIds, loadScenario, SCENARIO_FILES, ScenarioError } from './scenario.ts';

const meta = {
  class: 'backend-api',
  expectedTier: 1,
  description: 'Cart total skips the last item',
  report: 'GET /cart returned 500\n\nError: boom\n    at cart.ts:1:1',
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scenarios-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const opsMeta = { ...meta, class: 'infra-config', expectedTier: 3 };

async function scenario(
  id: string,
  files: Partial<Record<string, string>> = {},
  kind: 'code' | 'ops' = 'code',
): Promise<string> {
  const dir = join(root, id);
  await mkdir(dir);
  const json = JSON.stringify(kind === 'ops' ? opsMeta : meta);
  for (const file of new Set([...SCENARIO_FILES[kind], ...Object.keys(files)])) {
    const body = file in files ? files[file] : file === 'meta.json' ? json : '';
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
    expect(await loadScenario(dir)).toEqual({ id: '001-cart-total', dir, kind: 'code', meta });
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

describe('loadScenario for an ops scenario (Tier 3)', () => {
  it('loads one with break-ops.sh and fix-ops.sh and no patch', async () => {
    const dir = await scenario('029-bad-override', {}, 'ops');
    expect(await loadScenario(dir)).toEqual({
      id: '029-bad-override',
      dir,
      kind: 'ops',
      meta: opsMeta,
    });
  });

  it('reports the ops files it is missing', async () => {
    const dir = await scenario('029-bad-override', { 'fix-ops.sh': undefined }, 'ops');
    expect(await problems(dir)).toEqual(['missing fix-ops.sh']);
  });

  it('requires the ops scripts to be executable', async () => {
    const dir = await scenario('029-bad-override', {}, 'ops');
    await chmod(join(dir, 'break-ops.sh'), 0o644);
    expect(await problems(dir)).toEqual(['break-ops.sh is not executable']);
  });

  it('rejects code files in an ops scenario', async () => {
    const dir = await scenario('029-bad-override', { 'reference_fix.patch': '' }, 'ops');
    expect(await problems(dir)).toEqual([
      'reference_fix.patch is for code scenarios (expectedTier 1 or 2)',
    ]);
  });

  it('rejects ops files in a Tier 1 or 2 scenario', async () => {
    const dir = await scenario('001-cart-total', { 'fix-ops.sh': '' });
    expect(await problems(dir)).toEqual(['fix-ops.sh is for ops scenarios (expectedTier 3)']);
  });

  it('expects the ops files when a Tier 3 meta.json sits in a code layout', async () => {
    const dir = await scenario('001-cart-total', { 'meta.json': JSON.stringify(opsMeta) });
    expect(await problems(dir)).toEqual([
      'missing break-ops.sh',
      'missing fix-ops.sh',
      'break.sh is for code scenarios (expectedTier 1 or 2)',
      'reference_fix.patch is for code scenarios (expectedTier 1 or 2)',
    ]);
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
