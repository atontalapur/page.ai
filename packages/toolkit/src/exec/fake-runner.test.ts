import { describe, expect, it } from 'vitest';
import { FakeRunner } from './fake-runner.ts';

describe('FakeRunner', () => {
  it('exits 0 with no output by default and records the request', async () => {
    const runner = new FakeRunner();
    const request = { command: 'ls', timeoutMs: 1 };
    await expect(runner.run(request)).resolves.toEqual(FakeRunner.exited(0));
    expect(runner.requests).toEqual([request]);
  });
});
