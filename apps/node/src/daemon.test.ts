import { jobFixtures } from '@page/contracts/fixtures';
import { FakeRunner, InMemoryAuditSink } from '@page/toolkit';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createDaemon, type Adapters } from './daemon.ts';
import { FakeJobSource } from './jobs/fake-job-source.ts';
import { FakeLink } from './link/fake-link.ts';
import { bashReply, ScriptedModel, submitReply } from './model/scripted-model.ts';
import { FakeSandboxes } from './sandbox/fake-sandboxes.ts';

function adapters() {
  const close = vi.fn(() => Promise.resolve());
  const a = {
    jobs: new FakeJobSource(),
    sandboxes: new FakeSandboxes(),
    sink: new InMemoryAuditSink(),
    link: new FakeLink(),
    model: new ScriptedModel([bashReply('git status'), submitReply()]),
    close,
  } satisfies Adapters;
  return { ...a, closed: close };
}

describe('createDaemon', () => {
  it('runs each claimed job and streams its steps', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver(jobFixtures.fix);

    expect(a.sink.steps).toMatchObject([{ runId: jobFixtures.fix.runId, input: 'git status' }]);
    expect(a.link.sent.map((s) => s.event)).toEqual([
      'node.step',
      'node.diff',
      'node.run.finished',
    ]);
  });

  it('stops claiming before it closes the adapters, even if stopping fails', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    await daemon.stop();
    expect(a.jobs.stopped).toBe(true);
    expect(a.closed).toHaveBeenCalledOnce();

    a.jobs.stop = () => Promise.reject(new Error('offWork failed'));
    await expect(daemon.stop()).rejects.toThrow('offWork failed');
    expect(a.closed).toHaveBeenCalledTimes(2);
  });

  it('kills the run a run.kill names and leaves no sandbox behind', async () => {
    const a = adapters();
    const { runId } = jobFixtures.fix;
    const sandboxes = new FakeSandboxes(() => {
      a.link.deliver('run.kill', { v: 1, runId });
      return FakeRunner.exited(0);
    });
    const daemon = createDaemon({ ...a, sandboxes }, pino({ enabled: false }));
    await daemon.start();
    await a.jobs.deliver(jobFixtures.fix);

    expect(a.link.payloads('node.run.finished')).toMatchObject([{ runId, status: 'killed' }]);
    expect(sandboxes.started).toEqual([`pageagents-${runId}`]);
    expect(sandboxes.running).toEqual([]);
  });

  it('ignores a kill for a run it is not holding', async () => {
    const a = adapters();
    const daemon = createDaemon(a, pino({ enabled: false }));
    await daemon.start();
    a.link.deliver('run.kill', { v: 1, runId: jobFixtures.fix.runId });
    await a.jobs.deliver(jobFixtures.fix);
    expect(a.link.payloads('node.run.finished')).toMatchObject([{ status: 'succeeded' }]);
  });
});
