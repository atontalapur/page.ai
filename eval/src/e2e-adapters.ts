import {
  BUG_CLASSES,
  FIX_QUEUE,
  ISSUE_STATUSES,
  RUN_STATUSES,
  SEVERITIES,
  tierSchema,
} from '@page/contracts';
import type { SqlClient } from '@page/toolkit';
import { z } from 'zod';
import {
  JOB_STATES,
  type Clock,
  type IssueRow,
  type PipelineControl,
  type PipelineReader,
  type RunProgress,
} from './e2e.ts';

// The real adapters behind the end-to-end test's database and orchestrator ports. They
// only read the database, through any `pg` Pool or Client; the one write, the reset's
// kill, goes through the orchestrator's API like any other client's.

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

const issueRow = z.object({
  id: z.string(),
  fingerprint: z.string(),
  title: z.string(),
  status: z.enum(ISSUE_STATUSES),
  class: z.enum(BUG_CLASSES).nullable(),
  severity: z.enum(SEVERITIES).nullable(),
  current_tier: tierSchema.nullable(),
  current_run_id: z.string().nullable(),
  occurrences: z.number(),
  created_at: z.date(),
  last_seen_at: z.date(),
});

const runRow = z.object({
  id: z.string(),
  tier: tierSchema,
  status: z.enum(RUN_STATUSES),
  started_at: z.date().nullable(),
  finished_at: z.date().nullable(),
  pr_url: z.string().nullable(),
});

const countRow = z.object({ n: z.number() });
const jobRow = z.object({ state: z.enum(JOB_STATES) });
const nowRow = z.object({ now: z.date() });
const idRow = z.object({ id: z.string() });

const ISSUE_COLUMNS = `id, fingerprint, title, status, class, severity, current_tier,
  current_run_id, occurrences, created_at, last_seen_at`;

function toIssue(raw: unknown): IssueRow {
  const row = issueRow.parse(raw);
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    status: row.status,
    class: row.class,
    severity: row.severity,
    currentTier: row.current_tier,
    currentRunId: row.current_run_id,
    occurrences: row.occurrences,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Reads issues, runs, steps, approvals and the fix job from the orchestrator's database. */
export class PgPipelineReader implements PipelineReader {
  private readonly db: SqlClient;
  private readonly jobTable: string;

  /** `pgbossSchema` is the orchestrator's PGBOSS_SCHEMA. */
  constructor(db: SqlClient, { pgbossSchema = 'pgboss' }: { pgbossSchema?: string } = {}) {
    if (!SCHEMA_NAME.test(pgbossSchema)) {
      throw new Error(`PGBOSS_SCHEMA must be a plain schema name, not ${pgbossSchema}`);
    }
    this.db = db;
    this.jobTable = `${pgbossSchema}.job`;
  }

  async now(): Promise<Date> {
    const { rows } = await this.db.query('select now() as now', []);
    return nowRow.parse(rows[0]).now;
  }

  async issuesSeenSince(since: Date): Promise<IssueRow[]> {
    const { rows } = await this.db.query(
      `select ${ISSUE_COLUMNS} from issues where last_seen_at >= $1
       order by created_at desc limit 50`,
      [since],
    );
    return rows.map(toIssue);
  }

  async issue(id: string): Promise<IssueRow | null> {
    const { rows } = await this.db.query(`select ${ISSUE_COLUMNS} from issues where id = $1`, [id]);
    return rows.length === 0 ? null : toIssue(rows[0]);
  }

  async run(runId: string): Promise<RunProgress> {
    const [run, steps, approvals, job] = await Promise.all([
      this.db.query(
        'select id, tier, status, started_at, finished_at, pr_url from runs where id = $1',
        [runId],
      ),
      this.db.query('select count(*)::int as n from steps where run_id = $1', [runId]),
      this.db.query(
        `select count(*)::int as n from approvals where run_id = $1 and decision = 'pending'`,
        [runId],
      ),
      this.db.query(
        `select state::text as state from ${this.jobTable} where name = $1 and id = $2`,
        [FIX_QUEUE, runId],
      ),
    ]);
    const row = run.rows.length === 0 ? null : runRow.parse(run.rows[0]);
    return {
      runId,
      run:
        row === null
          ? null
          : {
              id: row.id,
              tier: row.tier,
              status: row.status,
              startedAt: row.started_at,
              finishedAt: row.finished_at,
              prUrl: row.pr_url,
            },
      jobState: job.rows.length === 0 ? null : jobRow.parse(job.rows[0]).state,
      steps: countRow.parse(steps.rows[0]).n,
      pendingApprovals: countRow.parse(approvals.rows[0]).n,
    };
  }

  async runIdsForIssue(issueId: string): Promise<string[]> {
    const [jobs, runs] = await Promise.all([
      this.db.query(
        `select id::text as id from ${this.jobTable}
         where name = $1 and data->>'issueId' = $2 order by created_on`,
        [FIX_QUEUE, issueId],
      ),
      this.db.query('select id::text as id from runs where issue_id = $1 order by created_at', [
        issueId,
      ]),
    ]);
    const ids = [...jobs.rows, ...runs.rows].map((row) => idRow.parse(row).id);
    return [...new Set(ids)];
  }
}

/**
 * The orchestrator's HTTP API (apps/orchestrator README, API). Every route it calls needs
 * ORCHESTRATOR_API_TOKEN as a bearer token.
 */
export class OrchestratorControl implements PipelineControl {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly doFetch: typeof fetch;

  constructor(baseUrl: string, apiToken: string, doFetch: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiToken = apiToken;
    this.doFetch = doFetch;
  }

  async killIssue(id: string): Promise<void> {
    const path = `/issues/${encodeURIComponent(id)}/events`;
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiToken}` },
      body: JSON.stringify({ type: 'kill' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`POST ${path} answered ${res.status}${body === '' ? '' : `: ${body}`}`);
    }
  }
}

/** Wall-clock time. */
export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason as Error);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason as Error);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};
