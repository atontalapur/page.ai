import { Controller, Get, Inject } from '@nestjs/common';
import type { SpendStats } from '@page/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/database.ts';
import { DB } from '../tokens.ts';

/** What the agents have spent, for the dashboard. */
@Controller('stats')
export class StatsController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Model spend over every session: each run's agent calls, and jev's decisions. Embeddings
   * and PR answers aren't metered here, and cost a fraction of a cent each.
   */
  @Get('spend')
  async spend(): Promise<SpendStats> {
    const runs = await this.db
      .selectFrom('runs')
      .select([
        sql<number>`coalesce(sum(cost_usd), 0)::float8`.as('usd'),
        sql<number>`count(*)::int`.as('n'),
      ])
      .executeTakeFirstOrThrow();
    const decisions = await this.db
      .selectFrom('decisions')
      .select([
        sql<number>`coalesce(sum(cost_usd), 0)::float8`.as('usd'),
        sql<number>`count(*)::int`.as('n'),
      ])
      .executeTakeFirstOrThrow();
    const runsUsd = Number(runs.usd);
    const decisionsUsd = Number(decisions.usd);
    return {
      totalUsd: runsUsd + decisionsUsd,
      runsUsd,
      decisionsUsd,
      runs: Number(runs.n),
      decisions: Number(decisions.n),
    };
  }
}
