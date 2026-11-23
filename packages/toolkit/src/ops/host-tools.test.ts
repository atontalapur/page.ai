import { describe, expect, it } from 'vitest';
import type { Deployment } from '../deploy/deployer.ts';
import { FakeDeployer } from '../deploy/fake-deployer.ts';
import { deployment } from '../deploy/test-utils.ts';
import type { HostToolCall } from '../exec/types.ts';
import { FakeOps } from './fake-ops.ts';
import { MAX_SETTING_VALUE, OpsHostTools, type OpsHostToolsOptions } from './host-tools.ts';
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
        rollback: null,
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
        rollback: null,
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
        rollback: null,
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
        rollback: null,
      });
      expect(fake.overrides.has('C')).toBe(false);
    });
  });

  describe('rollback', () => {
    const plan: HostToolCall = { kind: 'host_tool', tool: 'ops.planRollback' };
    const rollBack = (to: string): HostToolCall => ({
      kind: 'host_tool',
      tool: 'ops.rollback',
      to,
    });

    // A bad deploy is live, and the deploy before it served traffic.
    function setup(options: Partial<OpsHostToolsOptions> = {}) {
      const previous = deployment({ commitSha: 'good' });
      const live = deployment({ status: 'SUCCESS', commitSha: 'bad' });
      const deployer = options.deployer ?? new FakeDeployer([live, previous]);
      const ops = new FakeOps();
      const tools = new OpsHostTools({ ops, deployer, rollbackPollMs: 1, ...options });
      return { live, previous, deployer: deployer as FakeDeployer, ops, tools };
    }

    it('is not set up without a deployer', async () => {
      const tools = new OpsHostTools({ ops: new FakeOps() });
      expect(tools.handles('ops.planRollback')).toBe(false);
      expect(tools.handles('ops.rollback')).toBe(false);
      expect(tools.handles('ops.restart')).toBe(true);
      expect(await tools.run(plan, 1000)).toEqual({
        ok: false,
        output: 'ops.planRollback is not set up on this node',
      });
      expect(setup().tools.handles('ops.rollback')).toBe(true);
    });

    it('plans first, deploying nothing, and shows what is live and what would go back', async () => {
      const { live, previous, deployer, tools } = setup();
      const out = await tools.run(plan, 1000);

      expect(out.ok).toBe(true);
      expect(out.output).toMatch(/^Rollback plan, a dry run: nothing was deployed\.\n/);
      expect(out.output).toContain(`"id": "${live.id}"`);
      expect(out.output).toContain('"commit": "bad"');
      expect(out.output).toContain(`"rollBackTo": {\n    "id": "${previous.id}"`);
      expect(out.output).toMatch(
        new RegExp(
          `ops.rollback to ${previous.id} deploys that build again in place of ${live.id}\\.$`,
        ),
      );
      expect(deployer.rollbacks).toEqual([]);
      expect(tools.changedApp).toBe(false);
    });

    it('rolls back to the planned target, waits until it is live, and counts it', async () => {
      const { live, previous, deployer, tools } = setup();
      await tools.run(plan, 1000);
      const out = await tools.run(rollBack(previous.id), 1000);

      expect(out).toEqual({
        ok: true,
        output:
          `Rolled back: ${previous.id} (good) is deploying in place of ${live.id} (bad).\n` +
          'Deployment rollback-0 is live after 0s.',
      });
      expect(deployer.rollbacks).toEqual([previous.id]);
      expect(tools.rollbacks).toBe(1);
      expect(tools.changedApp).toBe(true);
    });

    it('refuses a rollback with no plan, or to a target the plan did not name', async () => {
      const { live, previous, deployer, tools } = setup();
      expect(await tools.run(rollBack(previous.id), 1000)).toEqual({
        ok: false,
        output:
          'plan the rollback first: ops.planRollback shows what is live and what a rollback would deploy',
      });
      await tools.run(plan, 1000);
      expect(await tools.run(rollBack(live.id), 1000)).toEqual({
        ok: false,
        output: `the last plan goes back to ${previous.id}, not ${live.id}; send the target it named`,
      });
      expect(deployer.rollbacks).toEqual([]);
      // Neither used up the run's one rollback.
      expect((await tools.run(rollBack(previous.id), 1000)).ok).toBe(true);
    });

    it('rolls back once per run', async () => {
      const older = deployment({ commitSha: 'older' });
      const { deployer, tools } = setup();
      deployer.deployments.push(older);
      await tools.run(plan, 1000);
      await tools.run(rollBack(deployer.deployments[1]!.id), 1000);

      // There is still something to go back to, but the run has had its rollback.
      expect((await tools.run(plan, 1000)).ok).toBe(true);
      expect(await tools.run(rollBack(older.id), 1000)).toEqual({
        ok: false,
        output: 'this run has rolled the app back once, the most one run may',
      });
      expect(deployer.rollbacks).toHaveLength(1);
    });

    it('refuses while a deploy is in flight, and sends nothing', async () => {
      const { previous, deployer, tools } = setup();
      await tools.run(plan, 1000);
      const building = deployment({ status: 'BUILDING' });
      deployer.deployments.unshift(building);

      expect(await tools.run(rollBack(previous.id), 1000)).toEqual({
        ok: false,
        output: `no rollback: deployment ${building.id} is BUILDING and would replace the rollback; wait for it or cancel it`,
      });
      expect((await tools.run(plan, 1000)).ok).toBe(false);
      expect(deployer.rollbacks).toEqual([]);
      expect(tools.rollbacks).toBe(0);
    });

    it('refuses when another deployment went live after the plan, which must be made again', async () => {
      const { live, previous, deployer, tools } = setup();
      await tools.run(plan, 1000);
      deployer.deployments[0]!.status = 'REMOVED';
      const newer = deployment({ status: 'SUCCESS' });
      deployer.deployments.unshift(newer);

      expect(await tools.run(rollBack(previous.id), 1000)).toEqual({
        ok: false,
        output: `no rollback: deployment ${newer.id} is live now, not ${live.id}, which the plan was made against`,
      });
      expect(await tools.run(rollBack(previous.id), 1000)).toMatchObject({
        output: expect.stringMatching(/^plan the rollback first/) as string,
      });
      expect(deployer.rollbacks).toEqual([]);
    });

    it('counts a rollback the deployer never answered, but not as a change to the app', async () => {
      const { live, previous, deployer, tools } = setup();
      await tools.run(plan, 1000);
      deployer.failOn = 'rollback';

      expect(await tools.run(rollBack(previous.id), 1000)).toEqual({
        ok: false,
        output:
          `rolling back to ${previous.id}: deployer is down\n` +
          'The rollback may have started. ops.planRollback shows what is live now.',
      });
      expect(tools.rollbacks).toBe(1);
      expect(tools.changedApp).toBe(false);
      expect((await tools.undo()).rollback).toEqual({
        from: live.id,
        to: previous.id,
        accepted: false,
      });
    });

    describe('waiting for the new deployment', () => {
      /** A FakeDeployer whose rollback deployment goes through `stages`, one per listing. */
      class StagedDeployer extends FakeDeployer {
        private readonly stages: string[];
        constructor(deployments: Deployment[], stages: string[]) {
          super(deployments);
          this.stages = [...stages];
        }
        override listDeployments(limit: number) {
          const stage = this.rollbacks.length > 0 ? this.stages.shift() : undefined;
          if (stage !== undefined) this.deployments[0]!.status = stage;
          return super.listDeployments(limit);
        }
      }
      const staged = (stages: string[]) => {
        const previous = deployment();
        const live = deployment({ status: 'SUCCESS' });
        return { previous, deployer: new StagedDeployer([live, previous], stages) };
      };

      it('keeps asking while it deploys', async () => {
        const { previous, deployer } = staged(['INITIALIZING', 'DEPLOYING', 'SUCCESS']);
        const { tools } = setup({ deployer });
        await tools.run(plan, 1000);
        const out = await tools.run(rollBack(previous.id), 1000);
        expect(out.ok).toBe(true);
        expect(out.output).toMatch(/\nDeployment rollback-\d+ is live after 0s\.$/);
      });

      it('fails when the new deployment fails', async () => {
        const { previous, deployer } = staged(['DEPLOYING', 'FAILED']);
        const { tools } = setup({ deployer });
        await tools.run(plan, 1000);
        const out = await tools.run(rollBack(previous.id), 1000);
        expect(out.ok).toBe(false);
        expect(out.output).toMatch(
          /\nDeployment rollback-\d+ ended FAILED after 0s, so the rollback is not live\. ops\.planRollback shows what is live now\.$/,
        );
        // The deployer took it, so it may have changed the app.
        expect(tools.changedApp).toBe(true);
      });

      it('gives up when its time runs out, and says what it last saw', async () => {
        const { previous, deployer } = staged(['DEPLOYING']);
        const { tools } = setup({ deployer });
        await tools.run(plan, 1000);
        const out = await tools.run(rollBack(previous.id), 30);
        expect(out.ok).toBe(false);
        expect(out.output).toMatch(
          /\nIt was not live within 0s: deployment rollback-\d+ is DEPLOYING\.$/,
        );
      });

      it('says so when no new deployment shows up, and keeps asking a deployer that fails', async () => {
        /** Takes the rollback, then lists nothing new and fails every other listing. */
        class Silent extends FakeDeployer {
          private lists = 0;
          override rollbackTo(id: string) {
            this.rollbacks.push(id);
            return Promise.resolve();
          }
          override listDeployments(limit: number) {
            this.lists += 1;
            return this.rollbacks.length > 0 && this.lists % 2 === 0
              ? Promise.reject(new Error('deployer is down'))
              : super.listDeployments(limit);
          }
        }
        const previous = deployment();
        const live = deployment({ status: 'SUCCESS' });
        const { tools } = setup({ deployer: new Silent([live, previous]) });
        await tools.run(plan, 1000);
        const out = await tools.run(rollBack(previous.id), 30);
        expect(out.ok).toBe(false);
        expect(out.output).toMatch(
          /\nIt was not live within 0s: no new deployment has shown up\.$/,
        );
      });
    });

    it('sends nothing once the run is stopped', async () => {
      const stop = new AbortController();
      const { deployer, tools } = setup({ signal: stop.signal });
      stop.abort();
      expect(await tools.run(plan, 1000)).toEqual({
        ok: false,
        output: 'ops.planRollback stopped: the run was stopped',
      });
      expect(deployer.rollbacks).toEqual([]);
    });

    it('is refused with the other ops tools when given a refusal', async () => {
      const { deployer, tools } = setup({ refusal: 'the app is in use' });
      expect(await tools.run(plan, 1000)).toEqual({ ok: false, output: 'the app is in use' });
      expect(deployer.rollbacks).toEqual([]);
    });

    it('stays live after undo, which still puts back the overrides', async () => {
      const ops = new FakeOps({ A: '1' });
      const { live, previous, deployer, tools } = setup({ ops });
      await tools.run(unset('A'), 1000);
      await tools.run(plan, 1000);
      await tools.run(rollBack(previous.id), 1000);

      expect(await tools.undo()).toEqual({
        restored: ['A'],
        unknown: [],
        restarted: false,
        failed: [],
        rollback: { from: live.id, to: previous.id, accepted: true },
      });
      expect(ops.overrides.get('A')).toBe('1');
      expect(deployer.rollbacks).toEqual([previous.id]);
      expect(deployer.deployments[0]).toMatchObject({ status: 'SUCCESS', commitSha: 'good' });
      expect(tools.changedApp).toBe(true);
    });
  });
});
