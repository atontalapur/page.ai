import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { hashToken, newDashboardToken, parseDashboardTokens } from './dashboard-tokens.ts';

const run = promisify(execFile);
const script = join(import.meta.dirname, '../../scripts/dashboard-token.ts');

describe('hashToken', () => {
  it('is the SHA-256 of the token in lowercase hex', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('newDashboardToken', () => {
  it('makes a 32-byte base64url token and the entry that admits it', () => {
    const made = newDashboardToken('  Arjun ', Buffer.alloc(32, 7));
    expect(made.name).toBe('Arjun');
    expect(made.token).toBe(Buffer.alloc(32, 7).toString('base64url'));
    expect(made.entry).toBe(`Arjun:${hashToken(made.token)}`);
    expect(parseDashboardTokens(made.entry)).toEqual([
      { name: 'Arjun', sha256: hashToken(made.token) },
    ]);
  });

  it('makes a new token each time', () => {
    const a = newDashboardToken('Arjun');
    const b = newDashboardToken('Arjun');
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
  });

  it.each(['', 'ui:arjun', 'a,b', '-arjun', 'a'.repeat(41)])('refuses the name %j', (name) => {
    expect(() => newDashboardToken(name)).toThrow('a name is 1 to 40 letters');
  });
});

// Each case starts a Node process that loads the contracts, which takes seconds on a busy
// machine, so these get longer than the default 5s.
describe('scripts/dashboard-token.ts', { timeout: 30_000 }, () => {
  it('prints the token once and the entry whose hash matches it', async () => {
    const { stdout } = await run(process.execPath, [script, 'Nidheesh']);
    const token = /^ {2}([A-Za-z0-9_-]{43})$/m.exec(stdout)?.[1];
    expect(token).toBeDefined();
    const sha256 = createHash('sha256').update(token!).digest('hex');
    expect(stdout).toContain(`  Nidheesh:${sha256}\n`);
    expect(stdout.split(token!)).toHaveLength(2);
  });

  it('exits 2 with the usage for a bad name or none', async () => {
    const runs = [[], ['ui:x'], ['a', 'b']].map((args) =>
      run(process.execPath, [script, ...args]).catch((err: unknown) => err),
    );
    for (const failed of await Promise.all(runs)) {
      expect(failed).toMatchObject({ code: 2 });
      expect((failed as { stderr: string }).stderr).toContain('usage: pnpm --filter');
    }
  });
});
