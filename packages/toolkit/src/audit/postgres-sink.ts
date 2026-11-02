import type { AuditSink, StepEntry, StepOutcome } from './sink.ts';

/** The one method the sink needs. A `pg` Pool or Client fits. */
export interface SqlClient {
  query(text: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Writes steps to the `steps` table from #25. */
export class PostgresAuditSink implements AuditSink {
  private readonly db: SqlClient;

  constructor(db: SqlClient) {
    this.db = db;
  }

  async open(entry: StepEntry): Promise<void> {
    await this.db.query(
      `insert into steps (run_id, seq, kind, input, output_trimmed, exit_code, allowed)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.runId,
        entry.seq,
        entry.kind,
        entry.input,
        entry.outputTrimmed,
        entry.exitCode,
        entry.allowed,
      ],
    );
  }

  async close(runId: string, seq: number, outcome: StepOutcome): Promise<void> {
    const { rowCount } = await this.db.query(
      `update steps set output_trimmed = $3, exit_code = $4 where run_id = $1 and seq = $2`,
      [runId, seq, outcome.outputTrimmed, outcome.exitCode],
    );
    if (rowCount !== 1) throw new Error(`step ${runId}/${seq} was never opened`);
  }
}
