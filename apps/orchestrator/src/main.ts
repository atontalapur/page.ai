import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadMigrations } from '@page/db-migrations';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.ts';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createDb } from './db/database.ts';
import { migrate } from './db/migrate.ts';
import { createFixJobQueue } from './queue/fix-jobs.ts';

const logger = new Logger('orchestrator');
let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  // The message already names each bad var; a stack trace would only bury it.
  logger.error(err.message);
  process.exit(1);
}

const db = createDb(config.databaseUrl);
const boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgbossSchema });
// pg-boss reports background failures as events; an unhandled 'error' would crash the process.
boss.on('error', (err) => logger.error(err));
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
      logger.error(`closing ${name} failed`, err);
    }
  }
  return ok;
}

try {
  const applied = await migrate(db, await loadMigrations());
  logger.log(applied.length ? `applied ${applied.join(', ')}` : 'migrations up to date');
  await boss.start();
  app = await createApp({ db, fixJobs: await createFixJobQueue(boss) });
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  logger.error('startup failed', err);
  await close();
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (s) => {
    logger.log(`${s}, shutting down`);
    void close().then((ok) => process.exit(ok ? 0 : 1));
  });
}
