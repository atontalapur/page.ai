import { Module, type DynamicModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApprovalsModule } from './approvals/approvals.module.ts';
import { CoreModule } from './core.module.ts';
import { ApiTokenGuard } from './auth/api-token.guard.ts';
import { MeController } from './auth/me.controller.ts';
import type { AppDeps } from './deps.ts';
import { DebugModule } from './debug/debug.module.ts';
import { GatewayModule } from './gateway/gateway.module.ts';
import { GitHubModule } from './github/github.module.ts';
import { HealthController } from './health/health.controller.ts';
import { IngestModule } from './ingest/ingest.module.ts';
import { KnowledgeModule } from './knowledge/knowledge.module.ts';
import { IssuesController } from './issues/issues.controller.ts';
import { NotifyModule } from './notify/notify.module.ts';
import { RunsModule } from './runs/runs.module.ts';
import { TriageModule } from './triage/triage.module.ts';

@Module({})
export class AppModule {
  static forRoot(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(deps),
        IngestModule,
        TriageModule,
        RunsModule,
        ApprovalsModule,
        NotifyModule,
        GatewayModule,
        DebugModule,
        KnowledgeModule,
        GitHubModule,
      ],
      controllers: [HealthController, IssuesController, MeController],
      providers: [{ provide: APP_GUARD, useClass: ApiTokenGuard }],
    };
  }
}
