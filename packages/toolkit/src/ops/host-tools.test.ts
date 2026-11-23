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

  it('refuses every call, sending nothing, when given a refusal', async () => {
    const ops = new FakeOps();
    const tools = new OpsHostTools({ ops, refusal: 'the app is in use' });
    expect(await tools.run(set('A', '1'), 1000)).toEqual({
      ok: false,
      output: 'the app is in use',
    });
    expect(await tools.run(get, 1000)).toEqual({ ok: false, output: 'the app is in use' });
    expect(ops.calls).toEqual([]);
    expect(await tools.undo()).toMatchObject({ unknown: [], restarted: false });
  });

  describe('changedApp', () => {
    it('is false until a change lands, and after one the run set back itself', async () => {
      const ops = new FakeOps({ A: '1' });
      const tools = new OpsHostTools({ ops });
      await tools.run(get, 1000);
      expect(tools.changedApp).toBe(false);
      await tools.run(set('A', '2'), 1000);
      expect(tools.changedApp).toBe(true);
      await tools.run(set('A', '1'), 1000);
      expect(tools.changedApp).toBe(false);
      await tools.run(unset('B'), 1000);
      expect(tools.changedApp).toBe(false);
    });

    it('counts a restart after a change, even one the run took back later', async () => {
      const tools = new OpsHostTools({ ops: new FakeOps() });
      await tools.run(restart, 1000);
      expect(tools.changedApp).toBe(false);
      await tools.run(set('X', 'a'), 1000);
      await tools.run(restart, 1000);
      await tools.run(unset('X'), 1000);
      expect(tools.changedApp).toBe(true);
    });

    it('leaves out a change that failed or never answered', async () => {
      const ops = opsWith({
        setConfig: (key) =>
          key === 'LOST'
            ? Promise.reject(new OpsError('ops API PUT failed: reset'))
            : Promise.resolve({ status: 400, body: { error: 'invalid_value' } }),
      });
      const tools = new OpsHostTools({ ops });
      await tools.run(set('BAD', 'x'), 1000);
      await tools.run(set('LOST', 'x'), 1000);
      expect(tools.changedApp).toBe(false);
    });

    it('is false once undo has put everything back', async () => {
      const tools = new OpsHostTools({ ops: new FakeOps({ A: '1' }) });
      await tools.run(unset('A'), 1000);
      await tools.run(restart, 1000);
      await tools.undo();
      expect(tools.changedApp).toBe(false);
    });
  });

  describe('undo', () => {
    it('puts back every override the run changed, and restarts if the run had', async () => {
      const ops = new FakeOps({ SHIPPING_FLAT_CENTS: '2500000000' });
      const tools = new OpsHostTools({ ops });
      await tools.run(set('SHIPPING_FLAT_CENTS', '500'), 1000);
      await tools.run(unset('SHIPPING_FLAT_CENTS'), 1000);
      await tools.run(set('TAX_RATE', '0.2'), 1000);
      await tools.run(restart, 1000);
      ops.calls.length = 0;

      expect(await tools.undo()).toEqual({
        restored: ['SHIPPING_FLAT_CENTS', 'TAX_RATE'],
        unknown: [],
        restarted: true,
        failed: [],
      });
      expect(ops.calls).toEqual([
        'setConfig SHIPPING_FLAT_CENTS=2500000000',
        'deleteConfig TAX_RATE',
        'restart',
      ]);
      expect(Object.fromEntries(ops.overrides)).toEqual({ SHIPPING_FLAT_CENTS: '2500000000' });
      expect(ops.served).toEqual({ SHIPPING_FLAT_CENTS: '2500000000' });
      // Done once: a second undo has nothing left to put back.
      expect(await tools.undo()).toEqual({
        restored: [],
        unknown: [],
        restarted: false,
        failed: [],
      });
    });

    it('restarts when the run served a change it later took back itself', async () => {
      const ops = new FakeOps();
      const tools = new OpsHostTools({ ops });
      await tools.run(set('X', 'a'), 1000);
      await tools.run(restart, 1000);
      await tools.run(unset('X'), 1000);
      expect(ops.served).toEqual({ X: 'a' });

      expect(await tools.undo()).toMatchObject({ restored: [], restarted: true, failed: [] });
      expect(ops.served).toEqual({});
    });

    it('needs no restart when the run never restarted, and skips what it put back', async () => {
      const ops = new FakeOps({ A: '1' });
      const tools = new OpsHostTools({ ops });
      await tools.run(set('A', '2'), 1000);
      await tools.run(set('A', '1'), 1000);
      await tools.run(set('B', '3'), 1000);
      ops.calls.length = 0;

      expect(await tools.undo()).toMatchObject({ restored: ['B'], restarted: false });
      expect(ops.calls).toEqual(['deleteConfig B']);
    });

    it('leaves alone a change that failed, and names one that never answered', async () => {
      const ops = opsWith({
        setConfig: (key) =>
          key === 'LOST'
            ? Promise.reject(new OpsError('ops API PUT failed: reset'))
            : Promise.resolve({ status: 400, body: { error: 'invalid_value' } }),
      });
      const tools = new OpsHostTools({ ops });
      expect((await tools.run(set('BAD', 'x'), 1000)).ok).toBe(false);
      expect((await tools.run(set('LOST', 'x'), 1000)).ok).toBe(false);

      expect(await tools.undo()).toEqual({
        restored: [],
        unknown: ['LOST'],
        restarted: false,
        failed: [],
      });
    });

    it('puts back a setting whose later change never answered', async () => {
      let lost = false;
      const fake = new FakeOps({ A: '1' });
      const ops = opsWith({
        setConfig: (key, value) =>
          lost ? Promise.reject(new OpsError('reset')) : fake.setConfig(key, value),
        deleteConfig: (key) => fake.deleteConfig(key),
      });
      const tools = new OpsHostTools({ ops });
      await tools.run(set('A', '2'), 1000);
      lost = true;
      await tools.run(set('A', '1'), 1000);
      lost = false;

      expect(await tools.undo()).toMatchObject({ restored: ['A'], unknown: [] });
      expect(fake.overrides.get('A')).toBe('1');
    });

    it('tries every setting and the restart, and reports what failed', async () => {
      const fake = new FakeOps();
      const ops = opsWith({
        setConfig: (key, value) => fake.setConfig(key, value),
        deleteConfig: (key) =>
          key === 'A'
            ? Promise.resolve({ status: 500, body: 'down' })
            : key === 'B'
              ? Promise.reject(new OpsError('refused'))
              : fake.deleteConfig(key),
        restart: () =>
          Promise.resolve({ status: 202, body: {}, healthy: { ok: false, afterMs: 1 } }),
      });
      const tools = new OpsHostTools({ ops });
      await tools.run(set('A', '1'), 1000);
      await tools.run(set('B', '1'), 1000);
      await tools.run(set('C', '1'), 1000);
      await tools.run(restart, 1000);

      expect(await tools.undo()).toEqual({
        restored: ['C'],
        unknown: [],
        restarted: false,
        failed: [
          'putting A back: 500 down',
          'putting B back: refused',
          'restarting the app: 202 {}',
        ],
      });
      expect(fake.overrides.has('C')).toBe(false);
    });
  });
});
