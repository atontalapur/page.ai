import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { NODE_HOLDING_INTERVAL_MS, type EscalationNote, type Tier } from '@page/contracts';
import { sql } from 'kysely';
import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { Logger } from '../logger.ts';
import { RunsService } from '../runs/runs.service.ts';
import { CONFIG, DB, LOGGER } from '../tokens.ts';
import { Nodes } from './nodes.ts';

/**
 * How long a claimed run may go without any daemon naming it before it counts as lost:
 * long enough for a reconnect and a few missed heartbeats, far shorter than the job's own
 * expiry, which would fail the issue.
 */
export const LOST_AFTER_MS = 4 * NODE_HOLDING_INTERVAL_MS + 10_000;
const SWEEP_EVERY_MS = 30_000;

interface Candidate {
  issue_id: string;
  run_id: string;
  tier: Tier;
  started_on: Date;
  /** The note the lost job carried from the tier below or a review, to hand on again. */
  note: EscalationNote | null;
}

/**
 * Finds fix runs a daemon claimed and then stopped working, and retries them. pg-boss marks
 * a claimed job active and leaves it so until it expires (FIX_EXPIRE_SECONDS), so a daemon
 * that restarts or crashes mid-run would leave its issue stuck that long, then failed.
 * Daemons name the runs they hold on every connect and every NODE_HOLDING_INTERVAL_MS; a run
 * active in pg-boss that none has named for LOST_AFTER_MS is lost, and RunsService.retryLost
 * queues it again at the same tier.
 *
 * Nothing is swept until LOST_AFTER_MS after boot, so daemons have time to reconnect to a
 * restarted orchestrator and name their runs.
 */
@Injectable()
export class OrphanSweeper implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private readonly bootedAt = Date.now();

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly nodes: Nodes,
    private readonly runs: RunsService,
  ) {}

  onModuleInit(): void {
    if (this.config.useFakeAdapters) return;
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /** Retries every lost run. Returns their run ids. */
  async sweep(now = Date.now()): Promise<string[]> {
    if (this.sweeping || now - this.bootedAt < LOST_AFTER_MS) return [];
    this.sweeping = true;
    try {
      const job = sql.table(`${this.config.pgbossSchema}.job`);
      const { rows } = await sql<Candidate>`
        select i.id as issue_id, i.current_run_id as run_id, i.current_tier as tier, j.started_on,
          j.data -> 'escalationNote' as note
        from issues i
        join ${job} j on j.id = i.current_run_id
        where i.status = 'fixing'
          and j.state = 'active'
          and j.started_on < ${new Date(now - LOST_AFTER_MS)}
      `.execute(this.db);
      const lost: string[] = [];
      for (const row of rows) {
        if (!this.nodes.lost(row.run_id, LOST_AFTER_MS)) continue;
        const outcome = await this.runs.retryLost(
          row.issue_id,
          row.run_id,
          row.tier,
          new Date(row.started_on),
          row.note ?? undefined,
        );
        if (outcome.kind === 'applied') lost.push(row.run_id);
      }
      return lost;
    } catch (error) {
      this.logger.error({ err: error }, 'could not sweep for lost runs');
      return [];
    } finally {
      this.sweeping = false;
    }
  }
}
