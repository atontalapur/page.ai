import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import { SkipApiToken } from '../auth/api-token.guard.ts';
import type { Db } from '../db/database.ts';
import { DB } from '../tokens.ts';

// Railway's health check sends no token.
@SkipApiToken()
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await sql`select 1`.execute(this.db);
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    return { status: 'ok' };
  }
}
