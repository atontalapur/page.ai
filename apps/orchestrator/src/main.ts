import { Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/database.ts';
import { loadMigrations, migrate } from './db/migrate.ts';
import { createFixJobQueue } from './queue/fix-jobs.ts';

const logger = new Logger('orchestrator');
const config = loadConfig();

const db = createDb(config.databaseUrl);
const applied = await migrate(db, await loadMigrations());
logger.log(applied.length ? `applied ${applied.join(', ')}` : 'migrations up to date');

const boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgbossSchema });
// pg-boss reports background failures as events; an unhandled 'error' would crash the process.
boss.on('error', (err) => logger.error(err));
await boss.start();

const app = await createApp({ db, fixJobs: await createFixJobQueue(boss) });
await app.listen({ port: config.port, host: config.host });

async function shutdown(signal: string) {
  logger.log(`${signal}, shutting down`);
  await app.close();
  await boss.stop({ graceful: true });
  await db.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (s) => void shutdown(s));
}
