import { Module, type DynamicModule } from '@nestjs/common';
import type { Db } from './db/database.ts';
import { HealthController } from './health/health.controller.ts';
import { IssuesController } from './issues/issues.controller.ts';
import { IssuesService } from './issues/issues.service.ts';
import type { FixJobQueue } from './queue/fix-jobs.ts';
import { DB, FIX_JOB_QUEUE } from './tokens.ts';

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
      controllers: [HealthController, IssuesController],
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: FIX_JOB_QUEUE, useValue: deps.fixJobs },
        IssuesService,
      ],
    };
  }
}
