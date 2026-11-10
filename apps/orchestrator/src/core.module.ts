import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { AppDeps } from './deps.ts';
import { IssuesService } from './issues/issues.service.ts';
import { CLASSIFIER, CONFIG, DB, FIX_JOB_QUEUE, JOB_QUEUES, LOGGER, PAGER } from './tokens.ts';

@Global()
@Module({})
export class CoreModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: DB, useValue: deps.db },
        { provide: FIX_JOB_QUEUE, useValue: deps.fixJobs },
        { provide: JOB_QUEUES, useValue: deps.jobs },
        { provide: LOGGER, useValue: deps.logger },
        { provide: CONFIG, useValue: deps.config },
        { provide: PAGER, useValue: deps.pager },
        { provide: CLASSIFIER, useValue: deps.classifier },
        IssuesService,
      ],
      exports: [DB, FIX_JOB_QUEUE, JOB_QUEUES, LOGGER, CONFIG, PAGER, CLASSIFIER, IssuesService],
    };
  }
}
