import { describe, expect, it } from 'vitest';
import { CHAT_CLOSE_REASONS, CHAT_REFUSALS, type RunChat } from '@page/contracts';
import {
  answeredChatFixture,
  nodeSummaryFixture,
  pendingChatFixture,
  stepFixture,
} from '@page/contracts/fixtures';

import { ASK_FAILURE_TEXT, chatStatus, chatsAfterSteps, heldByDaemon } from './runChat';

const step = (seq: number, createdAt: string) => ({ ...stepFixture, seq, createdAt });
const chat = (id: number, askedAt: string): RunChat => ({
  ...pendingChatFixture,
  id: `c5e3a9b7-1d2f-4c6e-9a8b-${String(id).padStart(12, '0')}`,
  askedAt,
});

describe('chatsAfterSteps', () => {
  const steps = [
    step(0, '2026-11-22T09:00:00.000Z'),
    step(1, '2026-11-22T09:00:20.000Z'),
    step(2, '2026-11-22T09:00:40.000Z'),
  ];

  it('puts each message after the last step that started before it', () => {
    const first = chat(1, '2026-11-22T08:59:00.000Z');
    const during = chat(2, '2026-11-22T09:00:10.000Z');
    const same = chat(3, '2026-11-22T09:00:20.000Z');
    const last = chat(4, '2026-11-22T09:01:00.000Z');
    const also = chat(5, '2026-11-22T09:01:05.000Z');
    expect(chatsAfterSteps(steps, [first, during, same, last, also])).toEqual(
      new Map([
        [-1, [first]],
        [0, [during]],
        [1, [same]],
        [2, [last, also]],
      ]),
    );
  });

  it('puts every message before the first step when there is none yet', () => {
    const asked = chat(1, '2026-11-22T09:00:10.000Z');
    expect(chatsAfterSteps([], [asked])).toEqual(new Map([[-1, [asked]]]));
    expect(chatsAfterSteps(steps, [])).toEqual(new Map());
  });
});

describe('chatStatus', () => {
  it('says a message waits, and nothing for an answered one', () => {
    expect(chatStatus(pendingChatFixture)).toBe("Waiting for the agent's next step.");
    expect(chatStatus(answeredChatFixture)).toBeNull();
  });

  it.each(CHAT_CLOSE_REASONS)('says why a message got no answer: %s', (reason) => {
    const closed: RunChat = {
      ...pendingChatFixture,
      status: 'unanswered',
      reason,
      closedAt: answeredChatFixture.closedAt,
    };
    expect(chatStatus(closed)).toMatch(/\.$/);
  });
});

describe('ASK_FAILURE_TEXT', () => {
  it.each([...CHAT_REFUSALS, 'offline', 'timeout'] as const)('explains %s', (failure) => {
    expect(ASK_FAILURE_TEXT[failure]).toMatch(/\.$/);
  });
});

describe('heldByDaemon', () => {
  const runId = nodeSummaryFixture.current[0]!.id;

  it('is true only while a connected daemon holds the run', () => {
    expect(heldByDaemon([nodeSummaryFixture], runId)).toBe(true);
    expect(heldByDaemon([nodeSummaryFixture], stepFixture.runId.replace('7c1e', '0000'))).toBe(
      false,
    );
    expect(heldByDaemon([{ ...nodeSummaryFixture, connected: false }], runId)).toBe(false);
    expect(heldByDaemon([], runId)).toBe(false);
  });
});
