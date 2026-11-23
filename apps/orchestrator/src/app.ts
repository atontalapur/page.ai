import 'reflect-metadata';
import { StandardSchemaValidationPipe, type LoggerService, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.ts';
import type { AppDeps } from './deps.ts';
import { serveUi } from './static/serve-ui.ts';

export async function createApp(
  deps: AppDeps,
  logger: LoggerService | LogLevel[] | false = ['log', 'warn', 'error'],
): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(deps),
    new FastifyAdapter(),
    { logger },
  );
  // Validates every parameter declared with `{ schema }` against its zod contract.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  await serveUi(app, deps.config.uiDistDir, deps.logger);
  return app;
}
