import { describe, expect, it } from 'vitest';
import type { IssueRun, Run, Step } from '@page/contracts';
import {
  answeredChatFixture,
  nodeRunFixture,
  nodeSummaryFixture,
  pendingChatFixture,
  runFixture,
  stepFixture,
} from '@page/contracts/fixtures';

import { applyToIssueRuns, applyToNode, applyToNodeRun, isFinished, withChat } from './runs';
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

describe('messages on a run', () => {
  const asked = (chat = pendingChatFixture): RunEvent => ({
    event: 'run.chat.asked',
    payload: { v: 1, chat },
  });
  const replied = (chat = answeredChatFixture): RunEvent => ({
    event: 'run.chat.reply',
    payload: { v: 1, chat },
  });

  it('adds a message to its run, and puts the answer in its place', () => {
    let runs = [issueRun()];
    runs = applyToIssueRuns(runs, asked(), runFixture.issueId);
    expect(runs[0]?.chats).toEqual([pendingChatFixture]);
    runs = applyToIssueRuns(runs, replied(), runFixture.issueId);
    expect(runs[0]?.chats).toEqual([answeredChatFixture]);
    // The run itself is left as it was.
    expect(runs[0]).toMatchObject({ status: runFixture.status, steps: [] });
  });

  it('keeps an answer against a pending copy that comes late, and orders by when asked', () => {
    const later = {
      ...pendingChatFixture,
      id: 'c5e3a9b7-1d2f-4c6e-9a8b-000000000009',
      askedAt: '2026-10-30T12:02:00.000Z',
    };
    const earlier = {
      ...later,
      id: 'c5e3a9b7-1d2f-4c6e-9a8b-000000000008',
      askedAt: runFixture.startedAt!,
    };
    let chats = withChat([], answeredChatFixture);
    chats = withChat(chats, pendingChatFixture);
    expect(chats).toEqual([answeredChatFixture]);
    chats = withChat(chats, later);
    chats = withChat(chats, earlier);
    expect(chats.map((c) => c.id)).toEqual([earlier.id, answeredChatFixture.id, later.id]);
  });

  it("ignores a message for a run the list doesn't have, and leaves a daemon's runs alone", () => {
    const other = { ...pendingChatFixture, runId: '90000000-2222-4222-8222-222222222222' };
    expect(applyToIssueRuns([issueRun()], asked(other), runFixture.issueId)).toEqual([issueRun()]);
    expect(applyToNodeRun(nodeRunFixture, asked())).toEqual(nodeRunFixture);
    expect(applyToNodeRun(nodeRunFixture, replied())).toEqual(nodeRunFixture);
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
