import { describe, expect, it } from 'vitest';
import type { Deployer } from './deployer.ts';
import { FakeDeployer } from './fake-deployer.ts';
import { planRollback, rollback, ROLLBACK_WINDOW } from './rollback.ts';
import { deployment } from './test-utils.ts';

// Newest first: a failed build after the live deploy, then two that served traffic.
function history() {
  const live = deployment({ status: 'SUCCESS' });
  const failed = deployment({ status: 'FAILED' });
  const previous = deployment({ status: 'REMOVED' });
  const older = deployment({ status: 'REMOVED' });
  return { live, failed, previous, older, list: [failed, live, previous, older] };
}

describe('planRollback', () => {
  it('goes from the live deployment to the one before it, past failed builds', () => {
    const { live, previous, list } = history();
    expect(planRollback(list)).toEqual({ ok: true, value: { from: live, to: previous } });
  });

  it('rolls back from a crashed deployment', () => {
    const crashed = deployment({ status: 'CRASHED' });
    const previous = deployment();
    expect(planRollback([crashed, previous])).toMatchObject({
      ok: true,
      value: { from: crashed, to: previous },
    });
  });

  it('skips a removed deployment whose image is gone', () => {
    const live = deployment({ status: 'SUCCESS' });
    const gone = deployment({ canRollback: false });
    const kept = deployment();
    expect(planRollback([live, gone, kept])).toMatchObject({ ok: true, value: { to: kept } });
  });

  it('fails with nothing live, or nothing to go back to', () => {
    expect(planRollback([deployment({ status: 'BUILDING' }), deployment()])).toMatchObject({
      ok: false,
      error: { type: 'no_live_deployment' },
    });
    expect(
      planRollback([deployment({ status: 'SUCCESS' }), deployment({ status: 'FAILED' })]),
    ).toMatchObject({ ok: false, error: { type: 'no_target' } });
  });

  it('takes an explicit target and checks it', () => {
    const { live, older, list } = history();
    expect(planRollback(list, older.id)).toMatchObject({
      ok: true,
      value: { from: live, to: older },
    });
    for (const to of ['nope', live.id]) {
      expect(planRollback(list, to)).toMatchObject({ ok: false, error: { type: 'bad_target' } });
    }
    const gone = deployment({ canRollback: false });
    expect(planRollback([live, gone], gone.id)).toMatchObject({
      ok: false,
      error: { type: 'bad_target', message: expect.stringContaining('no longer') as string },
    });
  });

  it('refuses an explicit target that never served, is newer, or is crashed', () => {
    const failed = deployment({ status: 'FAILED' });
    const live = deployment({ status: 'SUCCESS' });
    const neverServed = deployment({ status: 'FAILED' });
    const crashed = deployment({ status: 'CRASHED' });
    const list = [failed, live, neverServed, crashed];
    for (const to of [failed.id, neverServed.id, crashed.id]) {
      expect(planRollback(list, to)).toMatchObject({ ok: false, error: { type: 'bad_target' } });
    }
  });

  it('refuses while a newer deploy is still in flight', () => {
    const building = deployment({ status: 'BUILDING' });
    const live = deployment({ status: 'SUCCESS' });
    const previous = deployment();
    expect(planRollback([building, live, previous])).toMatchObject({
      ok: false,
      error: {
        type: 'deploy_in_progress',
        message: expect.stringContaining(building.id) as string,
      },
    });
    expect(planRollback([building, live, previous], previous.id)).toMatchObject({
      error: { type: 'deploy_in_progress' },
    });
  });

  it('after a rollback, goes back past the bad build and every copy of the live commit', () => {
    const older = deployment();
    const good = deployment({ commitSha: 'good' });
    const bad = deployment({ commitSha: 'bad' });
    const rebuilt = deployment({ status: 'CRASHED', commitSha: 'good' });
    expect(planRollback([rebuilt, bad, good, older])).toMatchObject({
      ok: true,
      value: { from: rebuilt, to: older },
    });
  });

  it('does not match commits when the live deployment has none', () => {
    const live = deployment({ status: 'SUCCESS', commitSha: null });
    const previous = deployment({ commitSha: null });
    expect(planRollback([live, previous])).toMatchObject({ ok: true, value: { to: previous } });
  });

  it('treats a status it does not know as neither live nor a target', () => {
    const live = deployment({ status: 'SUCCESS' });
    expect(planRollback([deployment({ status: 'TELEPORTING' }), live, deployment()])).toMatchObject(
      { ok: true, value: { from: live } },
    );
  });
});

describe('rollback', () => {
  it('previews without deploying', async () => {
    const { live, previous, list } = history();
    const deployer = new FakeDeployer(list);
    expect(await rollback(deployer, { dryRun: true })).toEqual({
      ok: true,
      value: { dryRun: true, plan: { from: live, to: previous } },
    });
    expect(deployer.rollbacks).toEqual([]);
  });

  it('redeploys the target, which then goes live', async () => {
    const { previous, list } = history();
    const deployer = new FakeDeployer(list);
    const result = await rollback(deployer, { dryRun: false });
    expect(result).toMatchObject({ ok: true, value: { dryRun: false } });
    expect(deployer.rollbacks).toEqual([previous.id]);

    const [newest] = await deployer.listDeployments(1);
    expect(newest).toMatchObject({ status: 'SUCCESS', commitSha: previous.commitSha });
  });

  it('returns a plan failure without deploying', async () => {
    const deployer = new FakeDeployer([deployment({ status: 'SUCCESS' })]);
    expect(await rollback(deployer, { dryRun: false })).toMatchObject({
      ok: false,
      error: { type: 'no_target' },
    });
    expect(deployer.rollbacks).toEqual([]);
  });

  it('turns deployer failures into deployer_failed', async () => {
    const deployer = new FakeDeployer(history().list);
    deployer.failOn = 'list';
    expect(await rollback(deployer, { dryRun: true })).toEqual({
      ok: false,
      error: { type: 'deployer_failed', message: 'listing deployments: deployer is down' },
    });
    deployer.failOn = 'rollback';
    expect(await rollback(deployer, { dryRun: false })).toMatchObject({
      ok: false,
      error: {
        type: 'deployer_failed',
        message: expect.stringMatching(/^rolling back to /) as string,
      },
    });
  });

  it('only looks at the recent window', async () => {
    const deployer = new FakeDeployer([
      deployment({ status: 'SUCCESS' }),
      ...Array.from({ length: ROLLBACK_WINDOW }, () => deployment({ status: 'FAILED' })),
      deployment(),
    ]);
    expect(await rollback(deployer, { dryRun: true })).toMatchObject({
      ok: false,
      error: { type: 'no_target' },
    });
  });
});

describe('FakeDeployer', () => {
  it('rejects a rollback to an unknown deployment', async () => {
    await expect(new FakeDeployer().rollbackTo('nope')).rejects.toThrow('no deployment nope');
  });
});

it('reports a deployer that rejects with a non-Error', async () => {
  const live = deployment({ status: 'SUCCESS' });
  const prev = deployment();
  const deployer: Deployer = {
    listDeployments: () => Promise.resolve([live, prev]),
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
    rollbackTo: () => Promise.reject('plain string'),
  };
  expect(await rollback(deployer, { dryRun: false })).toMatchObject({
    error: { message: `rolling back to ${prev.id}: plain string` },
  });
});
