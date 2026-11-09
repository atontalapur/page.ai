import { Module, type DynamicModule } from '@nestjs/common';
import { ApprovalsModule } from './approvals/approvals.module.ts';
import type { Db } from './db/database.ts';
import { GatewayModule } from './gateway/gateway.module.ts';
import { HealthController } from './health/health.controller.ts';
import { IngestModule } from './ingest/ingest.module.ts';
import { IssuesController } from './issues/issues.controller.ts';
import { IssuesService } from './issues/issues.service.ts';
import { NotifyModule } from './notify/notify.module.ts';
import type { FixJobQueue } from './queue/fix-jobs.ts';
import { RunsModule } from './runs/runs.module.ts';
import { TiersModule } from './tiers/tiers.module.ts';
import { DB, FIX_JOB_QUEUE } from './tokens.ts';
import { TriageModule } from './triage/triage.module.ts';

/** What the app needs from outside. main.ts builds the real ones, tests build PGlite ones. */
export interface AppDeps {
  db: Db;
  fixJobs: FixJobQueue;
}

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      imports: [
        IngestModule,
        TriageModule,
        RunsModule,
        TiersModule,
        ApprovalsModule,
        NotifyModule,
        GatewayModule,
      ],
      controllers: [HealthController, IssuesController],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: FIX_JOB_QUEUE, useValue: deps.fixJobs },
        IssuesService,
      ],
    };
  }
}
