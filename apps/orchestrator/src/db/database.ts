import type {
  Approval,
  BugClass,
  Confidence,
  Escalation,
  EscalationNote,
  IssueEvent,
  IssueStatus,
  Run,
  Severity,
  Step,
  Tier,
} from '@page/contracts';
import { Kysely, PostgresDialect, type ColumnType, type Generated } from 'kysely';
import pg from 'pg';

export interface IssuesTable {
  id: Generated<string>;
  fingerprint: string;
  title: string;
  status: Generated<IssueStatus>;
  class: BugClass | null;
  severity: Severity | null;
  current_tier: Tier | null;
  current_run_id: string | null;
  occurrences: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  last_seen_at: Generated<Date>;
}

export interface IssueEventsTable {
  // bigint identity. node-postgres returns it as a string, PGlite as a number.
  id: ColumnType<string | number, never, never>;
  issue_id: string;
  // jsonb, written as a JSON string so pg and PGlite serialise it the same way.
  event: ColumnType<IssueEvent, string, never>;
  from_status: IssueStatus;
  to_status: IssueStatus;
  current_tier: Tier | null;
  created_at: Generated<Date>;
}

// The jsonb columns below are written as JSON strings, like issue_events.event.

export interface RunsTable {
  // The fix job's pg-boss id.
  id: string;
  issue_id: string;
  tier: Tier;
  status: Generated<Run['status']>;
  started_at: Date | null;
  finished_at: Date | null;
  pr_url: string | null;
  confidence: ColumnType<Confidence | null, string | null | undefined, string | null>;
  created_at: Generated<Date>;
}

export interface StepsTable {
  run_id: string;
  seq: number;
  kind: Step['kind'];
  input: string;
  output_trimmed: Generated<string>;
  exit_code: number | null;
  allowed: boolean;
  created_at: Generated<Date>;
}

export interface EscalationsTable {
  id: Generated<string>;
  run_id: string;
  from_tier: Tier;
  to_tier: Tier;
  reason: Escalation['reason'];
  note: ColumnType<EscalationNote, string, string>;
  created_at: Generated<Date>;
}

export interface ApprovalsTable {
  id: Generated<string>;
  run_id: string;
  action: string;
  args: ColumnType<Record<string, unknown>, string | undefined, string>;
  decision: Generated<Approval['decision']>;
  decided_by: string | null;
  decided_at: Date | null;
  requested_at: Generated<Date>;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface Database {
  issues: IssuesTable;
  issue_events: IssueEventsTable;
  runs: RunsTable;
  steps: StepsTable;
  escalations: EscalationsTable;
  approvals: ApprovalsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}
