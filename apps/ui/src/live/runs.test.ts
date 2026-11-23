import { describe, expect, it } from 'vitest';
import type { IssueRun, Run, Step } from '@page/contracts';
import {
  nodeRunFixture,
  nodeSummaryFixture,
  runFixture,
  stepFixture,
} from '@page/contracts/fixtures';

import { applyToIssueRuns, applyToNode, applyToNodeRun, isFinished } from './runs';
import type { RunEvent } from './source';

const issueRun = (fields: Partial<IssueRun> = {}): IssueRun => ({
  ...runFixture,
  diff: null,
  steps: [],
  chats: [],
  ...fields,
});
const step = (seq: number, fields: Partial<Step> = {}): Step => ({
  ...stepFixture,
  seq,
  ...fields,
});
const stepped = (s: Step): RunEvent => ({ event: 'run.step', payload: { v: 1, step: s } });
const started = (run: Run): RunEvent => ({ event: 'run.started', payload: { v: 1, run } });
const finished = (run: Run): RunEvent => ({
  event: 'run.finished',
  payload: { v: 1, run, note: null },
});
const done: Run = {
  ...runFixture,
  status: 'succeeded',
  finishedAt: '2026-10-30T12:09:00.000Z',
  prUrl: 'https://github.com/atontalapur/page-demo/pull/9',
};

describe('applyToIssueRuns', () => {
  const issueId = runFixture.issueId;

  it('puts a step in its place by seq, and a final copy over an open one', () => {
    const open = step(1, { exitCode: null, outputTrimmed: '' });
    let runs = [issueRun({ steps: [step(0), open] })];
    runs = applyToIssueRuns(runs, stepped(step(3)), issueId);
    runs = applyToIssueRuns(runs, stepped(step(2)), issueId);
    runs = applyToIssueRuns(runs, stepped(step(1, { exitCode: 1 })), issueId);
    expect(runs[0]!.steps.map((s) => [s.seq, s.exitCode])).toEqual([
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 0],
    ]);
  });

  it('moves a queued run to running on its first step', () => {
    const queued = issueRun({ status: 'queued', startedAt: null });
    const [run] = applyToIssueRuns([queued], stepped(step(0)), issueId);
    expect(run).toMatchObject({ status: 'running', startedAt: stepFixture.createdAt });
  });

  it('keeps the diff, and the result once it finishes', () => {
    let runs = [issueRun()];
    const diff: RunEvent = {
      event: 'run.diff',
      payload: { v: 1, runId: runFixture.id, diff: '+fix' },
    };
    runs = applyToIssueRuns(runs, diff, issueId);
    runs = applyToIssueRuns(runs, finished(done), issueId);
    expect(runs[0]).toMatchObject({
      diff: '+fix',
      status: 'succeeded',
      finishedAt: done.finishedAt,
      prUrl: done.prUrl,
    });
    // A late run.started doesn't undo the result.
    expect(applyToIssueRuns(runs, started(runFixture), issueId)[0]?.status).toBe('succeeded');
  });

  it("adds a run when it starts on this issue, and ignores another issue's", () => {
    const other = { ...runFixture, id: crypto.randomUUID(), issueId: crypto.randomUUID() };
    expect(applyToIssueRuns([], started(other), issueId)).toEqual([]);
    expect(applyToIssueRuns([], stepped(step(0)), issueId)).toEqual([]);
    expect(applyToIssueRuns([], started(runFixture), issueId)).toEqual([
      { ...runFixture, diff: null, steps: [], chats: [] },
    ]);
  });
});

describe('applyToNodeRun', () => {
  it('keeps the newest step and counts up to it', () => {
    const run = { ...nodeRunFixture, stepCount: 1, lastStep: step(0) };
    const later = applyToNodeRun(run, stepped(step(4)));
    expect(later).toMatchObject({ stepCount: 5, lastStep: { seq: 4 } });
    expect(applyToNodeRun(later, stepped(step(2)))).toBe(later);
  });

  it('takes the result when it finishes', () => {
    expect(applyToNodeRun(nodeRunFixture, finished(done))).toMatchObject({
      status: 'succeeded',
      prUrl: done.prUrl,
    });
  });
});

describe('applyToNode', () => {
  it('updates the run the daemon holds, and leaves a daemon without it as it is', () => {
    const next = applyToNode(nodeSummaryFixture, stepped(step(3)));
    expect(next.current[0]).toMatchObject({ stepCount: 4, lastStep: { seq: 3 } });
    const idle = { ...nodeSummaryFixture, current: [] };
    expect(applyToNode(idle, stepped(step(3)))).toBe(idle);
  });
});

describe('isFinished', () => {
  it.each([
    ['queued', false],
    ['running', false],
    ['succeeded', true],
    ['escalated', true],
    ['failed', true],
    ['killed', true],
  ] as const)('%s: %s', (status, expected) => {
    expect(isFinished({ status })).toBe(expected);
  });
});
