import { describe, expect, it } from 'vitest';
import type { HostToolCall } from '../exec/types.ts';
import { FakeOps } from './fake-ops.ts';
import { MAX_SETTING_VALUE, OpsHostTools } from './host-tools.ts';
import { OpsError, type OpsApi } from './ops.ts';

const get: HostToolCall = { kind: 'host_tool', tool: 'ops.getConfig' };
const restart: HostToolCall = { kind: 'host_tool', tool: 'ops.restart' };
const set = (key: string, value: string): HostToolCall => ({
  kind: 'host_tool',
  tool: 'ops.setConfig',
  key,
  value,
});
const unset = (key: string): HostToolCall => ({ kind: 'host_tool', tool: 'ops.deleteConfig', key });

/** A FakeOps with some methods swapped out. */
function opsWith(over: Partial<OpsApi>): OpsApi {
  const fake = new FakeOps();
  return {
    getConfig: () => fake.getConfig(),
    setConfig: (key, value) => fake.setConfig(key, value),
    deleteConfig: (key) => fake.deleteConfig(key),
    restart: () => fake.restart(),
    ...over,
  };
}

describe('OpsHostTools', () => {
  it('handles the ops tools and nothing else', async () => {
    const tools = new OpsHostTools({ ops: new FakeOps() });
    expect(tools.handles('ops.restart')).toBe(true);
    expect(tools.handles('git.pushBranch')).toBe(false);
    const push: HostToolCall = { kind: 'host_tool', tool: 'git.pushBranch', message: 'm' };
    expect(await tools.run(push, 1000)).toEqual({
      ok: false,
      output: 'git.pushBranch is not an ops tool',
    });
  });

  it('drops an override, restarts, and shows the app what it answered', async () => {
    const ops = new FakeOps({ SHIPPING_FLAT_CENTS: '2500000000' });
    const tools = new OpsHostTools({ ops });

    const read = await tools.run(get, 1000);
    expect(read.ok).toBe(true);
    expect(read.output).toMatch(/^GET \/api\/ops\/config answered 200\n/);
    expect(read.output).toContain('"SHIPPING_FLAT_CENTS": "2500000000"');

    const dropped = await tools.run(unset('SHIPPING_FLAT_CENTS'), 1000);
    expect(dropped).toEqual({
      ok: true,
      output:
        'DELETE /api/ops/config/SHIPPING_FLAT_CENTS answered 200\n' +
        JSON.stringify(
          { key: 'SHIPPING_FLAT_CENTS', from: '2500000000', to: null, appliesOn: 'restart' },
          null,
          2,
        ),
    });
    // Not served until the restart.
    expect(ops.served).toEqual({ SHIPPING_FLAT_CENTS: '2500000000' });

    const restarted = await tools.run(restart, 1000);
    expect(restarted.ok).toBe(true);
    expect(restarted.output).toMatch(/The app is back: \/api\/health answered after 0s\.$/);
    expect(ops.served).toEqual({});
    expect(ops.calls).toEqual(['getConfig', 'deleteConfig SHIPPING_FLAT_CENTS', 'restart']);
  });

  it.each(['shipping', '../restart', 'A B', ''])(
    'refuses %j as a key without calling the app',
    async (key) => {
      const ops = new FakeOps();
      const tools = new OpsHostTools({ ops });
      const out = await tools.run(set(key, '1'), 1000);
      expect(out.ok).toBe(false);
      expect(out.output).toContain('is not a setting name');
      expect((await tools.run(unset(key), 1000)).ok).toBe(false);
      expect(ops.calls).toEqual([]);
    },
  );

  it('refuses a value past the limit', async () => {
    const ops = new FakeOps();
    const out = await new OpsHostTools({ ops }).run(set('K', 'x'.repeat(MAX_SETTING_VALUE + 1)), 1);
    expect(out).toEqual({
      ok: false,
      output: `a setting value is at most ${MAX_SETTING_VALUE} characters`,
    });
    expect(ops.calls).toEqual([]);
  });

  it('caps restarts per run', async () => {
    const ops = new FakeOps();
    const tools = new OpsHostTools({ ops, maxRestarts: 2 });
    expect((await tools.run(restart, 1000)).ok).toBe(true);
    expect((await tools.run(restart, 1000)).ok).toBe(true);
    expect(await tools.run(restart, 1000)).toEqual({
      ok: false,
      output: 'this run has restarted the app 2 times, the most one run may',
    });
    expect(ops.calls).toEqual(['restart', 'restart']);
  });

  it('fails on an error status, and on a restart the app never came back from', async () => {
    const ops = opsWith({
      getConfig: () => Promise.resolve({ status: 401, body: { error: 'unauthorized' } }),
      restart: () =>
        Promise.resolve({ status: 202, body: {}, healthy: { ok: false, afterMs: 90_000 } }),
    });
    const tools = new OpsHostTools({ ops });
    expect(await tools.run(get, 1000)).toEqual({
      ok: false,
      output: 'GET /api/ops/config answered 401\n{\n  "error": "unauthorized"\n}',
    });
    const out = await tools.run(restart, 1000);
    expect(out.ok).toBe(false);
    expect(out.output).toMatch(/did not answer \/api\/health within 90s\.$/);
  });

  it('reports an unreachable app, a timeout and a stopped run as failures', async () => {
    const unreachable = opsWith({
      getConfig: () => Promise.reject(new OpsError('ops API GET /api/ops/config failed: refused')),
    });
    expect(await new OpsHostTools({ ops: unreachable }).run(get, 1000)).toEqual({
      ok: false,
      output: 'ops API GET /api/ops/config failed: refused',
    });

    const hangs = opsWith({
      getConfig: (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    expect(await new OpsHostTools({ ops: hangs }).run(get, 5)).toEqual({
      ok: false,
      output: 'ops.getConfig ran out of time after 5 ms',
    });

    const stop = new AbortController();
    const pending = new OpsHostTools({ ops: hangs, signal: stop.signal }).run(get, 60_000);
    stop.abort();
    expect(await pending).toEqual({
      ok: false,
      output: 'ops.getConfig stopped: the run was stopped',
    });
  });
});
