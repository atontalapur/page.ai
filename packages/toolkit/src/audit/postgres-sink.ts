import type { AuditSink, NewStep, StepOutcome } from './sink.ts';

/** The one method the sink needs. A `pg` Pool or Client fits. */
export interface SqlClient {
  query(text: string, params: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
}

/** Writes steps to the `steps` table from #25. */
export class PostgresAuditSink implements AuditSink {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async open(step: NewStep): Promise<number> {
    // Numbered in the same statement as the insert, from what the run already has stored.
    const { rows } = await this.db.query(
      `insert into steps (run_id, seq, kind, input, output_trimmed, exit_code, allowed)
       select $1::uuid, coalesce(max(seq) + 1, 0), $2::text, $3::text, $4::text, $5::integer, $6::boolean
       from steps where run_id = $1::uuid
       returning seq`,
      [step.runId, step.kind, step.input, step.outputTrimmed, step.exitCode, step.allowed],
    );
    const seq = (rows[0] as { seq?: unknown } | undefined)?.seq;
    if (typeof seq !== 'number') throw new Error(`step insert for ${step.runId} returned no seq`);
    return seq;
  }

  async close(runId: string, seq: number, outcome: StepOutcome): Promise<void> {
    const { rowCount } = await this.db.query(
      `update steps set output_trimmed = $3, exit_code = $4 where run_id = $1 and seq = $2`,
      [runId, seq, outcome.outputTrimmed, outcome.exitCode],
    );
    if (rowCount !== 1) throw new Error(`step ${runId}/${seq} was never opened`);
  }
}
