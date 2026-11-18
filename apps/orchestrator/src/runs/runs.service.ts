import { Inject, Injectable } from '@nestjs/common';
import type { IssueEvent, JobPayload } from '@page/contracts';
import type { Db } from '../db/database.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { issueLogger, type Logger } from '../logger.ts';
import { DB, LOGGER } from '../tokens.ts';

export type RunFinishedJob = JobPayload<'run_finished'>;
type RunResult = RunFinishedJob['result'];

const REASON_MAX = 2000;

const clip = (text: string) =>
  text.length <= REASON_MAX ? text : `${text.slice(0, REASON_MAX - 3)}...`;

/**
 * The issue event a run's result applies. A success is a patch for review. An escalation
 * moves up a tier (or to `failed` past Tier 3) and hands its note to the next run. A failure
 * goes straight to `failed`: the daemon only fails a run a higher tier can't fix. A killed
 * run kills the issue.
 */
export function issueEventFor(result: RunResult): IssueEvent {
  const { runId } = result;
  switch (result.status) {
    case 'succeeded':
      return { type: 'patch_ready', runId };
    case 'escalated':
      return { type: 'escalate', runId, reason: clip(`${result.reason}: ${result.note.summary}`) };
    case 'failed': {
      const why = result.note ? `${result.note.summary} ${result.note.blocker}` : 'The run failed.';
      return { type: 'fail', runId, reason: clip(why) };
    }
    case 'killed':
      return { type: 'kill' };
  }
}

/** What `record` did with a result. */
export type RecordOutcome =
  | { kind: 'applied'; event: IssueEvent['type'] }
  // The run is no longer the issue's current one, or the issue has left `fixing`: the row is
  // kept for the record, and the issue is left alone.
  | { kind: 'stale' }
  | { kind: 'no_issue' };

/**
 * Records what the node daemon reports for each fix run (#8, #136). The `run_finished` job
 * is the record; the gateway (#34) will relay the same result to the UI later.
 */
@Injectable()
export class RunsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly issues: IssuesService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Writes the `runs` row and, for an escalation, the `escalations` row, then applies the
   * issue event, all in one transaction. The event queues the next tier's fix job with the
   * report and the escalation note. Safe to retry: the run row is upserted, the escalation
   * written once, and a result whose run is no longer current only updates its row.
   */
  async record(job: RunFinishedJob): Promise<RecordOutcome> {
    const { result } = job;
    const log = issueLogger(this.logger, {
      issueId: job.issueId,
      runId: result.runId,
      tier: job.tier,
    });

    const outcome = await this.db.transaction().execute(async (trx): Promise<RecordOutcome> => {
      // Locked first, so a concurrent event on the issue waits for this one.
      const issue = await trx
        .selectFrom('issues')
        .select(['status', 'current_run_id'])
        .where('id', '=', job.issueId)
        .forUpdate()
        .executeTakeFirst();
      if (!issue) return { kind: 'no_issue' };

      const row = {
        issue_id: job.issueId,
        tier: job.tier,
        status: result.status,
        started_at: new Date(job.startedAt),
        finished_at: new Date(job.finishedAt),
        pr_url: result.prUrl,
        confidence: result.confidence === null ? null : JSON.stringify(result.confidence),
        diff: job.diff,
      };
      await trx
        .insertInto('runs')
        .values({ id: result.runId, ...row })
        .onConflict((oc) => oc.column('id').doUpdateSet(row))
        .execute();

      if (result.status === 'escalated') {
        const written = await trx
          .selectFrom('escalations')
          .select('id')
          .where('run_id', '=', result.runId)
          .executeTakeFirst();
        if (!written) {
          await trx
            .insertInto('escalations')
            .values({
              run_id: result.runId,
              from_tier: job.tier,
              to_tier: result.toTier,
              reason: result.reason,
              note: JSON.stringify(result.note),
            })
            .execute();
        }
      }

      if (issue.status !== 'fixing' || issue.current_run_id !== result.runId) {
        return { kind: 'stale' };
      }
      const event = issueEventFor(result);
      await this.issues.apply(job.issueId, event, {
        trx,
        ...(result.note === null ? {} : { escalationNote: result.note }),
      });
      return { kind: 'applied', event: event.type };
    });

    if (outcome.kind === 'no_issue') {
      log.error({ status: result.status }, 'run finished for an issue that does not exist');
    } else if (outcome.kind === 'stale') {
      log.warn({ status: result.status }, 'recorded a run that is no longer current; issue left');
    } else {
      log.info({ status: result.status, event: outcome.event }, 'run recorded');
    }
    return outcome;
  }
}
