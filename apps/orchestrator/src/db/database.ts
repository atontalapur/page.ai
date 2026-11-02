import type { BugClass, IssueEvent, IssueStatus, Severity, Tier } from '@page/contracts';
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

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface Database {
  issues: IssuesTable;
  issue_events: IssueEventsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type Db = Kysely<Database>;

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString }) }),
  });
}
