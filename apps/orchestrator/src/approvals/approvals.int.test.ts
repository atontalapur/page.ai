import { randomUUID } from 'node:crypto';
import { approvalSchema, SYSTEM_DECIDERS, type Approval } from '@page/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { DecisionsService } from '../decisions/decisions.service.ts';
import { createSchemaDeps } from '../db/test-utils.ts';
import { IssueUpdates } from '../issues/issue-updates.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { RunsService } from '../runs/runs.service.ts';
import { ApprovalsService } from './approvals.service.ts';

// ApprovalsService on real Postgres: a request from a run with no runs row yet, its reason, the
// first decision winning, a deadline enforced by the database clock, and a kill closing the rest.

const deps = await createSchemaDeps();
const updates = new IssueUpdates(deps.logger);
const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger, updates);
const runs = new RunsService(
  deps.db,
  issues,
  deps.jobs,
  deps.logger,
  new DecisionsService(deps.db, null, deps.logger),
);
const approvals = new ApprovalsService(deps.db, runs, updates, deps.logger);
approvals.onModuleInit();
const heard: Approval[] = [];
approvals.subscribe((approval) => heard.push(approval));
afterAll(async () => {
  approvals.onModuleDestroy();
  await deps.close();
});

async function fixing() {
  const { issue } = await issues.report({ fingerprint: `int-${randomUUID()}`, title: 'Boom' });
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id! };
}

const ask = (runId: string, inMs = 60_000) => ({
  v: 1 as const,
  approvalId: randomUUID(),
  runId,
  action: 'ops.restart',
  args: { tool: 'ops.restart' },
  expiresAt: new Date(Date.now() + inMs).toISOString(),
});

describe('ApprovalsService on real Postgres', () => {
  it('stores a request from a run in progress, and lets the first decision stand', async () => {
    const { issueId, runId } = await fixing();
    const request = ask(runId);
    const pending = await approvals.request(request);
    expect(approvalSchema.parse(pending)).toMatchObject({ issueId, decision: 'pending' });
    // A run in progress has no runs row, which approvals no longer need.
    const row = await deps.db.selectFrom('runs').select('id').where('id', '=', runId).execute();
    expect(row).toEqual([]);

    const first = await approvals.decide(request.approvalId, 'approved', 'ui:Arjun');
    const second = await approvals.decide(request.approvalId, 'rejected', 'ui:Daniyal');
    expect(first).toMatchObject({ kind: 'decided', approval: { decidedBy: 'ui:Arjun' } });
    expect(second).toMatchObject({ kind: 'already_decided', approval: { decision: 'approved' } });
    expect((await approvals.request(request))?.decision).toBe('approved');
    expect(await approvals.forIssue(issueId)).toHaveLength(1);
  });

  it("keeps the agent's reason as plain text, and reads it back with the request", async () => {
    const { issueId, runId } = await fixing();
    const reason = "The override is wrong.\n<b>Approve</b> '; drop table approvals; --";
    const request = { ...ask(runId), reason };
    expect(approvalSchema.parse(await approvals.request(request)).reason).toBe(reason);
    expect((await approvals.forIssue(issueId)).map((a) => a.reason)).toEqual([reason]);
    expect((await approvals.request({ ...ask(runId), reason: null }))?.reason).toBeNull();
  });

  it('refuses a decision once the deadline has passed', async () => {
    const { runId } = await fixing();
    const request = ask(runId, -1_000);
    await approvals.request(request);
    // The deadline timer may close it first; either way the decision is refused.
    const outcome = await approvals.decide(request.approvalId, 'approved', 'ui:Arjun');
    expect(['expired', 'already_decided']).toContain(outcome.kind);
    expect(outcome).toMatchObject({ approval: { decidedBy: SYSTEM_DECIDERS.timedOut } });
  });

  it('closes the open requests of a killed issue', async () => {
    const { issueId, runId } = await fixing();
    const request = ask(runId);
    await approvals.request(request);
    await issues.apply(issueId, { type: 'kill' });
    await expect
      .poll(async () => (await approvals.forRun(runId))[0]?.decidedBy)
      .toBe(SYSTEM_DECIDERS.runEnded);
    expect(heard.filter((a) => a.id === request.approvalId).map((a) => a.decision)).toEqual([
      'pending',
      'rejected',
    ]);
  });
});
