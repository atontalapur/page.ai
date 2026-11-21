import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveAppKey, liveAppLockDir, tryLockLiveApp } from './live-app-lock.ts';

describe('tryLockLiveApp', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'live-app-lock-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('lets one process hold the app until it releases it', () => {
    const dir = join(root, 'app.lock');
    const release = tryLockLiveApp('https://demo.example.com', dir);
    expect(release).toBeTypeOf('function');
    expect(existsSync(dir)).toBe(true);
    expect(tryLockLiveApp('https://demo.example.com', dir)).toBeNull();

    release?.();
    expect(existsSync(dir)).toBe(false);
    const again = tryLockLiveApp('https://demo.example.com', dir);
    expect(again).toBeTypeOf('function');
    again?.();
  });

  it('keys the lock on the app, however its URL is spelled', () => {
    for (const same of ['https://demo.example.com/', 'https://DEMO.example.com:443']) {
      expect(liveAppLockDir(same)).toBe(liveAppLockDir('https://demo.example.com'));
    }
    expect(liveAppKey('http://localhost:3000/base//')).toBe('http://localhost:3000/base');
    expect(liveAppKey('not a url/')).toBe('not a url');
    expect(liveAppLockDir('https://a.example.com')).not.toBe(
      liveAppLockDir('https://b.example.com'),
    );
  });

  it('rethrows an error other than the lock being held', () => {
    expect(() => tryLockLiveApp('x', join(root, 'missing', 'app.lock'))).toThrow(/ENOENT/);
  });
});
