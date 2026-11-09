import type { LoggerService } from '@nestjs/common';
import type { Issue, JobPayload } from '@page/contracts';
import { pino, type DestinationStream, type Level, type Logger } from 'pino';
import type { LogLevel } from './config.ts';

export type { Logger } from 'pino';

/** The root logger: JSON lines on stdout, or on `destination` in tests. */
export function createLogger(level: LogLevel, destination?: DestinationStream) {
  const options = { level, base: { service: 'orchestrator' } };
  return destination ? pino(options, destination) : pino(options);
}

/** The fields that tie a log line to an issue, as the node daemon names them. */
export interface IssueLogFields {
  issueId: Issue['id'];
  runId?: JobPayload<'fix'>['runId'] | null;
  tier?: Issue['currentTier'];
}

/** A child logger that stamps every line with the issue's id, run and tier. */
export function issueLogger(logger: Logger, { issueId, runId, tier }: IssueLogFields): Logger {
  return logger.child({ issueId, runId, tier });
}

// A stack trace as Nest passes it: a first line, then "at file:line:col" frames.
const STACK = /^.+\n\s+at .+/;

/** Routes Nest's own logs (startup, routes, unhandled exceptions) through pino. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]) {
    this.write('info', message, params);
  }
  error(message: unknown, ...params: unknown[]) {
    this.write('error', message, params);
  }
  warn(message: unknown, ...params: unknown[]) {
    this.write('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]) {
    this.write('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]) {
    this.write('trace', message, params);
  }
  fatal(message: unknown, ...params: unknown[]) {
    this.write('fatal', message, params);
  }

  // Nest appends the logger's context as the last string, and error() may put a stack
  // (or undefined) before it.
  private write(level: Level, message: unknown, params: unknown[]) {
    const fields: Record<string, unknown> = {};
    const last = params.at(-1);
    if (typeof last === 'string' && !STACK.test(last)) {
      fields.context = last;
      params = params.slice(0, -1);
    }
    const rest: unknown[] = [];
    for (const param of params) {
      if (typeof param === 'string' && STACK.test(param)) fields.stack = param;
      else if (param !== undefined) rest.push(param);
    }
    if (rest.length > 0) fields.params = rest;
    if (message instanceof Error) this.logger[level]({ ...fields, err: message }, message.message);
    else if (typeof message === 'string') this.logger[level](fields, message);
    else this.logger[level]({ ...fields, detail: message });
  }
}
