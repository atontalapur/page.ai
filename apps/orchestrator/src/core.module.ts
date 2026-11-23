import { Global, Module, type DynamicModule } from '@nestjs/common';
import { ApiTokens } from './auth/api-tokens.ts';
import type { AppDeps } from './deps.ts';
import { IssueUpdates } from './issues/issue-updates.ts';
import { DecisionsService } from './decisions/decisions.service.ts';
import { GitHubAppService } from './github/github-app.service.ts';
import { IssuesService } from './issues/issues.service.ts';
import {
  ANSWERER,
  CLASSIFIER,
  CONFIG,
  DB,
  DECIDER,
  EMBEDDER,
  FIX_JOB_QUEUE,
  GITHUB,
  JOB_QUEUES,
  LOGGER,
  PAGER,
} from './tokens.ts';

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
        { provide: DECIDER, useValue: deps.decider },
        { provide: EMBEDDER, useValue: deps.embedder },
        { provide: GITHUB, useValue: deps.github },
        { provide: ANSWERER, useValue: deps.answerer },
        // One instance, so HTTP and the UI socket count an address's wrong tokens together.
        { provide: ApiTokens, useValue: new ApiTokens(deps.config, deps.logger) },
        IssueUpdates,
        IssuesService,
        DecisionsService,
        GitHubAppService,
      ],
      exports: [
        ApiTokens,
        DB,
        FIX_JOB_QUEUE,
        JOB_QUEUES,
        LOGGER,
        CONFIG,
        PAGER,
        CLASSIFIER,
        DECIDER,
        EMBEDDER,
        GITHUB,
        ANSWERER,
        IssueUpdates,
        IssuesService,
        DecisionsService,
        GitHubAppService,
      ],
    };
  }
}
