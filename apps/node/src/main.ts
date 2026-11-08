// The node daemon: claims fix jobs, runs each in a sandbox, streams steps back (#8).
// Usage: node --env-file-if-exists=../../.env src/main.ts (or `pnpm --filter @page/node start`).
import { pino } from 'pino';
import { loadConfig } from './config.ts';
import { createAdapters, createDaemon, type Daemon } from './daemon.ts';

const config = loadConfig(process.env);
if (!config.ok) {
  console.error(config.error);
  process.exit(2);
}

const logger = pino({ level: config.value.LOG_LEVEL, base: { service: 'node' } });
if (config.value.USE_FAKE_ADAPTERS)
  logger.warn('USE_FAKE_ADAPTERS is on: no Docker, model or socket');

let daemon: Daemon | undefined;
try {
  daemon = createDaemon(await createAdapters(config.value, logger), logger);
  await daemon.start();
} catch (error) {
  logger.fatal({ err: error }, 'startup failed');
  await daemon?.stop().catch(() => undefined);
  process.exit(1);
}

const running = daemon;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, (s) => {
    logger.info(`${s}, finishing runs in hand and shutting down`);
    running.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown failed');
        process.exit(1);
      },
    );
  });
}
