import type { OpsApi, OpsReply, RestartReply } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { checkVerdict, resetOverrides } from './live-app.ts';

/** An ops API that answers from `settings` and logs every call. */
function stubOps(
  settings: { key: string; env: string | null; override: string | null }[],
  over: Partial<OpsApi> = {},
) {
  const calls: string[] = [];
  const ok = (body: unknown): Promise<OpsReply> => Promise.resolve({ status: 200, body });
  const ops: OpsApi = {
    getConfig: () => {
      calls.push('get');
      return ok({ settings, current: null, afterRestart: { ok: true } });
    },
    setConfig: (key) => {
      calls.push(`set ${key}`);
      return ok({});
    },
    deleteConfig: (key) => {
      calls.push(`delete ${key}`);
      return ok({ key, to: null });
    },
    restart: (): Promise<RestartReply> => {
      calls.push('restart');
      return Promise.resolve({ status: 202, body: {}, healthy: { ok: true, afterMs: 10 } });
    },
    ...over,
  };
  return { ops, calls };
}

describe('resetOverrides', () => {
  it('drops every override, then restarts', async () => {
    const { ops, calls } = stubOps([
      { key: 'SHIPPING_FLAT_CENTS', env: '500', override: '2500000000' },
      { key: 'FREE_SHIPPING_MIN_CENTS', env: '5000', override: null },
      { key: 'CURRENCY', env: 'USD', override: 'EUR' },
    ]);
    expect(await resetOverrides(ops)).toEqual(['SHIPPING_FLAT_CENTS', 'CURRENCY']);
    expect(calls).toEqual(['get', 'delete SHIPPING_FLAT_CENTS', 'delete CURRENCY', 'restart']);
  });

  it('still restarts when there is nothing to drop', async () => {
    const { ops, calls } = stubOps([{ key: 'A', env: '1', override: null }]);
    expect(await resetOverrides(ops)).toEqual([]);
    expect(calls).toEqual(['get', 'restart']);
  });

  it('rejects when the config, a delete or the restart fails', async () => {
    const unauthorized = stubOps([], {
      getConfig: () => Promise.resolve({ status: 401, body: { error: 'unauthorized' } }),
    });
    await expect(resetOverrides(unauthorized.ops)).rejects.toThrow(
      'reading the live config failed: 401 {"error":"unauthorized"}',
    );

    const stuck = stubOps([{ key: 'A', env: null, override: 'x' }], {
      deleteConfig: () => Promise.resolve({ status: 500, body: 'boom' }),
    });
    await expect(resetOverrides(stuck.ops)).rejects.toThrow(
      'dropping the A override failed: 500 boom',
    );

    const down = stubOps([], {
      restart: () =>
        Promise.resolve({ status: 202, body: {}, healthy: { ok: false, afterMs: 90_000 } }),
    });
    await expect(resetOverrides(down.ops)).rejects.toThrow('restarting the live app failed');
  });
});

describe('checkVerdict', () => {
  it('reads 0 as fixed and 1 as the bug still there', () => {
    expect(checkVerdict(0, '')).toBe(true);
    expect(checkVerdict(1, 'checkout returned 500')).toBe(false);
  });

  it('throws for any other exit, since the check broke', () => {
    expect(() => checkVerdict(2, 'curl: (7) refused\n')).toThrow(
      'check.sh exited 2:\ncurl: (7) refused',
    );
  });
});
