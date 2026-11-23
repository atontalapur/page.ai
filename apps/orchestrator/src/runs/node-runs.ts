import { Inject, Injectable } from '@nestjs/common';
import type { NodeRun, Run } from '@page/contracts';
import type { Db } from '../db/database.ts';
import { DB } from '../tokens.ts';
import { toStep } from './runs.service.ts';

/**
 * Which node daemon worked each run (`run_nodes`), and those runs as the agents page shows
 * them. NodeGateway records a daemon's run on its first event for it, since the pg-boss
 * claim doesn't say which daemon took the job.
 */
@Injectable()
export class NodeRuns {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Records that `node` works `runId`. A run another daemon names later moves to it. */
  async record(runId: string, node: string): Promise<void> {
    await this.db
      .insertInto('run_nodes')
      .values({ run_id: runId, node_name: node })
      .onConflict((oc) => oc.column('run_id').doUpdateSet({ node_name: node }))
      .execute();
  }

  /** The daemons that worked the newest runs, at most `limit` of them, newest first. */
  async recentNames(limit: number): Promise<string[]> {
    const rows = await this.db
      .selectFrom('run_nodes')
      .select('node_name')
      .groupBy('node_name')
      .orderBy((eb) => eb.fn.max('created_at'), 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => row.node_name);
  }

  /** When each of `names` took its newest run. A name with no runs is left out. */
  async lastRunAt(names: readonly string[]): Promise<Map<string, string>> {
    if (names.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('run_nodes')
      .select((eb) => ['node_name', eb.fn.max('created_at').as('last')])
      .where('node_name', 'in', names)
      .groupBy('node_name')
      .execute();
    return new Map(rows.map((row) => [row.node_name, new Date(row.last).toISOString()]));
  }

  /** `node`'s runs that a run row or an issue knows, the one it took last first. */
  async forNode(node: string, limit: number): Promise<NodeRun[]> {
    const rows = await this.db
      .selectFrom('run_nodes')
      .select('run_id')
      .where('node_name', '=', node)
      .where((eb) =>
        eb.or([
          eb.exists(
            eb.selectFrom('runs').select('id').whereRef('runs.id', '=', 'run_nodes.run_id'),
          ),
          eb.exists(
            eb
              .selectFrom('issues')
              .select('id')
              .whereRef('issues.current_run_id', '=', 'run_nodes.run_id'),
          ),
        ]),
      )
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return this.describe(rows.map((row) => row.run_id));
  }

  /**
   * Each run in `ids` as the agents page shows it, in the order given. A recorded run comes
   * from its `runs` row. One without a row is its issue's current run: `running` (`queued`
   * before its first step) while the issue is fixing, and `killed` once the issue has moved
   * on without its result, since only a kill does that. A run neither table knows is left out.
   */
  async describe(ids: readonly string[]): Promise<NodeRun[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('runs')
      .innerJoin('issues', 'issues.id', 'runs.issue_id')
      .selectAll('runs')
      .select('issues.title')
      .where('runs.id', 'in', ids)
      .execute();
    const recorded = new Map(rows.map((row) => [row.id, row]));
    const open = ids.filter((id) => !recorded.has(id));
    const issues =
      open.length === 0
        ? []
        : await this.db
            .selectFrom('issues')
            .select(['id', 'title', 'status', 'current_tier', 'current_run_id'])
            .where('current_run_id', 'in', open)
            .execute();
    const owners = new Map(issues.map((issue) => [issue.current_run_id, issue]));
    const counts = await this.db
      .selectFrom('steps')
      .select((eb) => [
        'run_id',
        eb.fn.countAll<string | number>().as('count'),
        eb.fn.min('created_at').as('first'),
      ])
      .where('run_id', 'in', ids)
      .groupBy('run_id')
      .execute();
    const tally = new Map(counts.map((c) => [c.run_id, c]));
    const lasts = await this.db
      .selectFrom('steps')
      .selectAll()
      .distinctOn('run_id')
      .where('run_id', 'in', ids)
      .orderBy('run_id')
      .orderBy('seq', 'desc')
      .execute();
    const lastStep = new Map(lasts.map((row) => [row.run_id, toStep(row)]));

    return ids.flatMap((id): NodeRun[] => {
      const steps = tally.get(id);
      const stepCount = Number(steps?.count ?? 0);
      const firstStepAt = steps ? new Date(steps.first).toISOString() : null;
      const progress = { stepCount, lastStep: lastStep.get(id) ?? null };
      const row = recorded.get(id);
      if (row) {
        return [
          {
            id,
            issueId: row.issue_id,
            issueTitle: row.title,
            tier: row.tier,
            status: row.status,
            startedAt: row.started_at?.toISOString() ?? firstStepAt,
            finishedAt: row.finished_at?.toISOString() ?? null,
            prUrl: row.pr_url,
            confidence: row.confidence,
            ...progress,
          },
        ];
      }
      const issue = owners.get(id);
      if (!issue || issue.current_tier === null) return [];
      const status: Run['status'] =
        issue.status !== 'fixing' ? 'killed' : stepCount > 0 ? 'running' : 'queued';
      return [
        {
          id,
          issueId: issue.id,
          issueTitle: issue.title,
          tier: issue.current_tier,
          status,
          startedAt: firstStepAt,
          finishedAt: null,
          prUrl: null,
          confidence: null,
          ...progress,
        },
      ];
    });
  }
}
