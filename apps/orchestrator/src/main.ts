import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadMigrations } from '@page/db-migrations';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createDb } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { createLogger, NestPinoLogger } from './logger.ts';
import { buildPager } from './notify/pager.ts';
import { NotifyService } from './notify/notify.service.ts';
import { createFixJobQueue } from './queue/fix-jobs.ts';
import { createJobQueues } from './queue/queues.ts';
import { startWorkers } from './queue/workers.ts';
import { buildClassifier } from './triage/classify.ts';
import { TriageService } from './triage/triage.service.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // LOG_LEVEL is unknown here, but fatal passes every level. The message already names
  // each bad var; a stack trace would only bury it.
  createLogger('info').fatal(err.message);
  process.exit(1);
}

const logger = createLogger(config.logLevel);

const db = createDb(config.databaseUrl);
const boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgbossSchema });
// pg-boss reports background failures as events; an unhandled 'error' would crash the process.
boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
let app: NestFastifyApplication | undefined;

/** Closes whatever has started, newest first. Logs each failure and keeps going. */
async function close(): Promise<boolean> {
  let ok = true;
  const steps: [string, () => Promise<unknown>][] = [
    ['http server', async () => app?.close()],
    ['pg-boss', () => boss.stop({ graceful: true })],
    ['database pool', () => db.destroy()],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      ok = false;
      logger.error({ err }, `closing ${name} failed`);
    }
  }
  return ok;
}

try {
  const applied = await migrate(db, await loadMigrations());
  logger.info(applied.length ? `applied ${applied.join(', ')}` : 'migrations up to date');
  await boss.start();
  if (!config.useFakeAdapters && !config.openRouterApiKey) {
    logger.warn('OPENROUTER_API_KEY is unset; triage uses the rule fallback');
  }
  if (!config.useFakeAdapters && (!config.twilio || config.notifyTo.length === 0)) {
    logger.warn('twilio is not configured; pages are recorded and not sent');
  }
  const application = await createApp(
    {
      db,
      fixJobs: await createFixJobQueue(boss),
      jobs: await createJobQueues(boss),
      logger,
      config,
      pager: buildPager(config),
      classifier: buildClassifier(config),
    },
    new NestPinoLogger(logger),
  );
  app = application;
  await startWorkers(boss, {
    triage: (job) => application.get(TriageService).handle(job),
    notify: (job, attempt) => application.get(NotifyService).deliver(job, attempt),
  });
  await application.listen({ port: config.port, host: config.host });
} catch (err) {
  logger.fatal({ err }, 'startup failed');
  await close();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (s) => {
    logger.info(`${s}, shutting down`);
    void close().then((ok) => process.exit(ok ? 0 : 1));
  });
}
