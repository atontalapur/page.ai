import { describe, expect, it } from 'vitest';
import { createLogger, issueLogger, NestPinoLogger } from './logger.ts';

const issueId = '0b5e8f8e-4a4b-4b8e-9c1a-2f4f5e6a7b8c';
const runId = '9d2c1b0a-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

/** A root logger that keeps its lines in memory instead of writing to stdout. */
function capture(level: 'info' | 'trace' = 'info') {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, {
    write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes JSON lines tagged with the service, at or above its level', () => {
    const { logger, lines } = capture();
    logger.debug('hidden');
    logger.info('shown');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 30, service: 'orchestrator', msg: 'shown' });
  });
});

describe('issueLogger', () => {
  it('stamps every line with issueId, runId and tier', () => {
    const { logger, lines } = capture();
    const child = issueLogger(logger, { issueId, runId, tier: 2 });
    child.info('one');
    child.warn({ extra: true }, 'two');
    expect(lines).toEqual([
      expect.objectContaining({ issueId, runId, tier: 2, msg: 'one' }),
      expect.objectContaining({ issueId, runId, tier: 2, extra: true, msg: 'two' }),
    ]);
  });

  it('leaves out fields it was not given', () => {
    const { logger, lines } = capture();
    issueLogger(logger, { issueId }).info('opened');
    expect(lines[0]).toMatchObject({ issueId });
    expect(lines[0]).not.toHaveProperty('runId');
    expect(lines[0]).not.toHaveProperty('tier');
  });

  it('does not change the parent logger', () => {
    const { logger, lines } = capture();
    issueLogger(logger, { issueId, runId, tier: 1 });
    logger.info('root');
    expect(lines[0]).not.toHaveProperty('issueId');
  });
});

describe('NestPinoLogger', () => {
  const stack = 'Error: boom\n    at handler (/app/src/x.ts:1:2)';

  it('maps Nest levels onto pino levels and keeps the context', () => {
    const { logger, lines } = capture('trace');
    const nest = new NestPinoLogger(logger);
    nest.log('Mapped {/health, GET} route', 'RouterExplorer');
    nest.warn('w', 'Ctx');
    nest.debug('d', 'Ctx');
    nest.verbose('v', 'Ctx');
    nest.fatal('f', 'Ctx');
    expect(lines.map((l) => [l.level, l.msg, l.context])).toEqual([
      [30, 'Mapped {/health, GET} route', 'RouterExplorer'],
      [40, 'w', 'Ctx'],
      [20, 'd', 'Ctx'],
      [10, 'v', 'Ctx'],
      [60, 'f', 'Ctx'],
    ]);
  });

  it('keeps the stack and context of an error', () => {
    const { logger, lines } = capture();
    const nest = new NestPinoLogger(logger);
    nest.error('failed', stack, 'ExceptionsHandler');
    nest.error('no context', stack);
    expect(lines[0]).toMatchObject({
      level: 50,
      msg: 'failed',
      stack,
      context: 'ExceptionsHandler',
    });
    expect(lines[1]).toMatchObject({ msg: 'no context', stack });
    expect(lines[1]).not.toHaveProperty('context');
  });

  it('serializes an Error message and keeps other values', () => {
    const { logger, lines } = capture();
    const nest = new NestPinoLogger(logger);
    // Nest's exception filter passes the error itself, then undefined, then its context.
    nest.error(new Error('boom'), undefined, 'ExceptionsHandler');
    nest.log({ some: 'object' });
    expect(lines[0]).toMatchObject({
      msg: 'boom',
      context: 'ExceptionsHandler',
      err: { type: 'Error', message: 'boom' },
    });
    expect(lines[1]).toMatchObject({ level: 30, detail: { some: 'object' } });
  });
});
