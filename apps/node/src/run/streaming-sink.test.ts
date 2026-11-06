import type { Step } from '@page/contracts';
import { InMemoryAuditSink } from '@page/toolkit';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { StreamingAuditSink } from './streaming-sink.ts';

const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const at = new Date('2026-11-05T12:00:00.000Z');
const logger = pino({ enabled: false });

function setup(onStep?: (step: Step) => void) {
  const inner = new InMemoryAuditSink();
  const streamed: Step[] = [];
  const sink = new StreamingAuditSink({
    inner,
    logger,
    now: () => at,
    onStep: onStep ?? ((step) => streamed.push(step)),
  });
  return { inner, sink, streamed };
}

const allowed = { runId, kind: 'exec' as const, input: 'ls', outputTrimmed: '', exitCode: null };

describe('StreamingAuditSink', () => {
  it('streams an allowed step once it closes, with its outcome', async () => {
    const { inner, sink, streamed } = setup();
    const seq = await sink.open({ ...allowed, allowed: true });
    expect(streamed).toEqual([]);
    await sink.close(runId, seq, { outputTrimmed: 'a\nb', exitCode: 0 });
    expect(streamed).toEqual([
      {
        ...allowed,
        allowed: true,
        seq: 0,
        outputTrimmed: 'a\nb',
        exitCode: 0,
        createdAt: at.toISOString(),
      },
    ]);
    expect(inner.steps[0]).toMatchObject({ outputTrimmed: 'a\nb', exitCode: 0 });
  });

  it('streams a refusal when it is opened', async () => {
    const { sink, streamed } = setup();
    await sink.open({
      ...allowed,
      input: 'curl x',
      outputTrimmed: 'refused: curl',
      allowed: false,
    });
    expect(streamed).toMatchObject([{ seq: 0, allowed: false, outputTrimmed: 'refused: curl' }]);
  });

  it('streams nothing when the record fails, and passes the failure on', async () => {
    const { inner, sink, streamed } = setup();
    inner.failOn = 'open';
    await expect(sink.open({ ...allowed, allowed: true })).rejects.toThrow('audit sink is down');
    inner.failOn = null;
    const seq = await sink.open({ ...allowed, allowed: true });
    inner.failOn = 'close';
    await expect(sink.close(runId, seq, { outputTrimmed: '', exitCode: 0 })).rejects.toThrow();
    expect(streamed).toEqual([]);
  });

  it('keeps the record when streaming throws', async () => {
    const { inner, sink } = setup(() => {
      throw new Error('link down');
    });
    await sink.open({ ...allowed, allowed: false });
    expect(inner.steps).toHaveLength(1);
  });
});
