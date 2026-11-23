import { escalationNoteFixture, stepFixture } from '@page/contracts/fixtures';
import { afterAll, describe, expect, it } from 'vitest';
import { DecisionsService } from '../decisions/decisions.service.ts';
import { createSchemaDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { NodeRuns } from './node-runs.ts';
import { RunsService } from './runs.service.ts';

// node-postgres returns count(*) as a string and PGlite as a number, so the unit tests alone
// don't show the agents page's figures come out right on the database staging runs.

const deps = await createSchemaDeps();
afterAll(() => deps.close());

const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
const runs = new RunsService(
  deps.db,
  issues,
  deps.jobs,
  deps.logger,
  new DecisionsService(deps.db, null, deps.logger),
);
const nodeRuns = new NodeRuns(deps.db);

let n = 0;
async function fixing(title: string): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report({ fingerprint: `int-node-runs-${++n}`, title });
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id ?? '' };
}

async function wrote(runId: string, seq: number) {
  await deps.db
    .insertInto('steps')
    .values({
      run_id: runId,
      seq,
      kind: 'exec',
      input: `cmd ${seq}`,
      allowed: true,
      exit_code: 0,
      created_at: new Date(stepFixture.createdAt),
    })
    .execute();
}

describe('NodeRuns on real Postgres', () => {
  it("records each daemon's runs and describes them as the agents page shows them", async () => {
    const done = await fixing('Done');
    await nodeRuns.record(done.runId, 'int-node');
    await wrote(done.runId, 0);
    await runs.record({
      v: 1,
      issueId: done.issueId,
      tier: 1,
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: '2026-11-22T09:01:00.000Z',
      diff: null,
      result: {
        v: 1,
        runId: done.runId,
        status: 'escalated',
        prUrl: null,
        confidence: null,
        reason: 'tests_failing',
        toTier: 2,
        note: escalationNoteFixture,
      },
    });
    const live = await fixing('Live');
    // Another daemon named it first; the run moves to the one that names it last.
    await nodeRuns.record(live.runId, 'other-int-node');
    await nodeRuns.record(live.runId, 'int-node');
    await wrote(live.runId, 0);
    await wrote(live.runId, 1);
    await wrote(live.runId, 2);

    const described = await nodeRuns.forNode('int-node', 10);
    expect(described.map((r) => [r.issueTitle, r.status, r.stepCount, r.lastStep?.seq])).toEqual([
      ['Live', 'running', 3, 2],
      ['Done', 'escalated', 1, 0],
    ]);
    expect(described[0]?.startedAt).toBe(stepFixture.createdAt);
    expect(await nodeRuns.forNode('other-int-node', 10)).toEqual([]);

    expect(await nodeRuns.recentNames(10)).toContain('int-node');
    const last = await nodeRuns.lastRunAt(['int-node', 'nobody']);
    expect([...last.keys()]).toEqual(['int-node']);
    expect(Date.parse(last.get('int-node') ?? '')).not.toBeNaN();
  });
});
