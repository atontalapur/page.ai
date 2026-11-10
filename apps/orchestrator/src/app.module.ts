import { Module, type DynamicModule } from '@nestjs/common';
import { ApprovalsModule } from './approvals/approvals.module.ts';
import { CoreModule } from './core.module.ts';
import type { AppDeps } from './deps.ts';
import { GatewayModule } from './gateway/gateway.module.ts';
import { HealthController } from './health/health.controller.ts';
import { IngestModule } from './ingest/ingest.module.ts';
import { IssuesController } from './issues/issues.controller.ts';
import { NotifyModule } from './notify/notify.module.ts';
import { RunsModule } from './runs/runs.module.ts';
import { TiersModule } from './tiers/tiers.module.ts';
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
        TiersModule,
        ApprovalsModule,
        NotifyModule,
        GatewayModule,
      ],
      controllers: [HealthController, IssuesController],
    };
  }
}
