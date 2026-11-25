import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DecisionsService } from '../decisions/decisions.service.ts';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import type { Logger } from '../logger.ts';
import { FIX_QUEUE, type FixJob } from '../queue/fix-jobs.ts';
import { RUN_FINISHED_QUEUE } from '../queue/queues.ts';
import { RunsService } from '../runs/runs.service.ts';
import { Nodes, type NodeSocket } from './nodes.ts';
import { LOST_AFTER_MS, OrphanSweeper } from './orphan-sweeper.ts';

// The sweep's query joins `issues` with pg-boss's job table, so it runs on PGlite with both.
const deps = await createTestDeps();
afterAll(() => deps.close());
afterEach(() => {
  vi.useRealTimers();
});

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const runs = new RunsService(
  deps.db,
  issues,
  deps.jobs,
  deps.logger,
  new DecisionsService(deps.db, null, deps.logger),
);

let n = 0;

/** An issue in `fixing` whose Tier 1 job a daemon claimed, so pg-boss has it active. */
async function claimed(): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report({ fingerprint: `sweep-${++n}`, title: 'Boom' }, 'Boom');
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const jobs = await deps.boss.fetch<FixJob>(FIX_QUEUE, { batchSize: 100 });
  const job = jobs.find((j) => j.data.issueId === issue.id);
  if (!job) throw new Error(`no fix job for ${issue.id}`);
  return { issueId: issue.id, runId: job.data.runId };
}

/** A daemon that sends `node.holding` heartbeats and holds `runId`. */
function daemon(nodes: Nodes, runId: string, id = `socket-${++n}`): NodeSocket {
  const socket = { id } as NodeSocket;
  nodes.add(socket, '127.0.0.1', 'node-a');
  nodes.heartbeats(socket);
  nodes.hold(runId, socket);
  return socket;
}

/** Moves the clock past the point a run no daemon names counts as lost. */
const pastLost = () => vi.setSystemTime(Date.now() + LOST_AFTER_MS + 1_000);

// Only Date: pg-boss and PGlite keep their real timers.
const fakeDate = () => vi.useFakeTimers({ toFake: ['Date'] });

describe('OrphanSweeper', () => {
  it('retries a run whose daemon went away mid-run', async () => {
    fakeDate();
    const nodes = new Nodes(deps.logger);
    const sweeper = new OrphanSweeper(deps.db, deps.config, deps.logger, nodes, runs);
    const { issueId, runId } = await claimed();
    nodes.remove(daemon(nodes, runId));
    pastLost();

    expect(await sweeper.sweep()).toEqual([runId]);
    expect(await issues.get(issueId)).toMatchObject({ status: 'fixing', currentTier: 1 });
    const [lost] = await deps.boss.findJobs(FIX_QUEUE, { id: runId });
    expect(lost?.state).toBe('cancelled');
    const retried = await deps.boss.findJobs<FixJob>(FIX_QUEUE, { data: { issueId } });
    expect(retried.filter((j) => j.state === 'created').map((j) => j.data.tier)).toEqual([1]);
  });

  it('leaves a run its daemon still holds, however long it runs', async () => {
    fakeDate();
    const nodes = new Nodes(deps.logger);
    const sweeper = new OrphanSweeper(deps.db, deps.config, deps.logger, nodes, runs);
    const { issueId, runId } = await claimed();
    daemon(nodes, runId);
    pastLost();

    expect(await sweeper.sweep()).toEqual([]);
    const [job] = await deps.boss.findJobs(FIX_QUEUE, { id: runId });
    expect(job?.state).toBe('active');
    expect((await issues.get(issueId)).status).toBe('fixing');
  });

  it('sweeps nothing until LOST_AFTER_MS after boot, so daemons can reconnect first', async () => {
    fakeDate();
    const nodes = new Nodes(deps.logger);
    const { runId } = await claimed();
    nodes.remove(daemon(nodes, runId));
    pastLost();
    const sweeper = new OrphanSweeper(deps.db, deps.config, deps.logger, nodes, runs);

    expect(await sweeper.sweep()).toEqual([]);
    expect(await sweeper.sweep(Date.now() + LOST_AFTER_MS)).toEqual([runId]);
  });

  it('leaves a lost run whose result is already queued, and does not count it', async () => {
    fakeDate();
    const nodes = new Nodes(deps.logger);
    const sweeper = new OrphanSweeper(deps.db, deps.config, deps.logger, nodes, runs);
    const { issueId, runId } = await claimed();
    nodes.remove(daemon(nodes, runId));
    // The daemon queued its result under the run id, then went away. Only the id is read.
    await deps.boss.send(RUN_FINISHED_QUEUE, { v: 1 }, { id: runId });
    pastLost();

    expect(await sweeper.sweep()).toEqual([]);
    const [job] = await deps.boss.findJobs(FIX_QUEUE, { id: runId });
    expect(job?.state).toBe('active');
    expect((await issues.get(issueId)).status).toBe('fixing');
  });

  it('sweeps on a timer from boot, except on the fake adapters, until shutdown', () => {
    // Only the interval: each sweep is stubbed, so nothing here reads the database.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const booted = (useFakeAdapters: boolean) => {
      const config = { ...deps.config, useFakeAdapters };
      const sweeper = new OrphanSweeper(deps.db, config, deps.logger, new Nodes(deps.logger), runs);
      const sweep = vi.spyOn(sweeper, 'sweep').mockResolvedValue([]);
      sweeper.onModuleInit();
      return { sweeper, sweep };
    };
    const live = booted(false);
    const fake = booted(true);

    vi.advanceTimersByTime(60_000);
    expect(live.sweep).toHaveBeenCalled();
    expect(fake.sweep).not.toHaveBeenCalled();

    const swept = live.sweep.mock.calls.length;
    live.sweeper.onModuleDestroy();
    fake.sweeper.onModuleDestroy();
    vi.advanceTimersByTime(60_000);
    expect(live.sweep).toHaveBeenCalledTimes(swept);
  });

  it('runs one sweep at a time', async () => {
    fakeDate();
    const nodes = new Nodes(deps.logger);
    const sweeper = new OrphanSweeper(deps.db, deps.config, deps.logger, nodes, runs);
    const { runId } = await claimed();
    nodes.remove(daemon(nodes, runId));
    pastLost();

    expect(await Promise.all([sweeper.sweep(), sweeper.sweep()])).toEqual([[runId], []]);
  });

  it('logs a sweep that fails and finds nothing, so the next one can run', async () => {
    fakeDate();
    const error = vi.fn();
    const logger = { error } as unknown as Logger;
    const config = { ...deps.config, pgbossSchema: 'no_such_schema' };
    const sweeper = new OrphanSweeper(deps.db, config, logger, new Nodes(deps.logger), runs);
    pastLost();

    expect(await sweeper.sweep()).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.anything(), 'could not sweep for lost runs');
    expect(await sweeper.sweep()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
