import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { ApprovalsController } from './approvals/approvals.controller.ts';
import { ApprovalsService } from './approvals/approvals.service.ts';
import { createTestDeps } from './db/test-utils.ts';
import { GatewayController } from './gateway/gateway.controller.ts';
import { GatewayService } from './gateway/gateway.service.ts';
import { IngestController } from './ingest/ingest.controller.ts';
import { IngestService } from './ingest/ingest.service.ts';
import { NotifyController } from './notify/notify.controller.ts';
import { NotifyService } from './notify/notify.service.ts';
import { RunsController } from './runs/runs.controller.ts';
import { RunsService } from './runs/runs.service.ts';
import { TiersController } from './tiers/tiers.controller.ts';
import { TiersService } from './tiers/tiers.service.ts';
import { TriageController } from './triage/triage.controller.ts';
import { TriageService } from './triage/triage.service.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
});

describe('orchestrator modules', () => {
  it.each([
    { service: IngestService, controller: IngestController },
    { service: TriageService, controller: TriageController },
    { service: RunsService, controller: RunsController },
    { service: TiersService, controller: TiersController },
    { service: ApprovalsService, controller: ApprovalsController },
    { service: NotifyService, controller: NotifyController },
    { service: GatewayService, controller: GatewayController },
  ])('resolves $service.name and its controller', ({ service, controller }) => {
    expect(app.get(service)).toBeInstanceOf(service);
    expect(app.get(controller)).toBeInstanceOf(controller);
  });

  it('still serves /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});
