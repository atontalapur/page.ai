import { describe, expect, it } from 'vitest';
import {
  answeredChatFixture,
  nodeToServerEventFixtures,
  pendingChatFixture,
  serverToNodeEventFixtures,
  uiToServerEventFixtures,
} from './__fixtures__/index.ts';
import {
  CHAT_CLOSE_REASONS,
  closedChatSchema,
  MAX_CHAT_ANSWER_CHARS,
  MAX_CHAT_CHARS,
  pendingChatSchema,
  runChatSchema,
} from './db.ts';
import {
  nodeToServerEvents,
  serverToNodeEvents,
  serverToUiEvents,
  uiToServerEvents,
} from './events.ts';
import { roundTrip } from './test-utils.ts';

const unanswered = {
  ...pendingChatFixture,
  status: 'unanswered',
  reason: 'submitted',
  closedAt: answeredChatFixture.closedAt,
};

describe('runChatSchema', () => {
  it.each([
    ['pending', pendingChatFixture],
    ['answered', answeredChatFixture],
    ['unanswered', unanswered],
  ])('round-trips a %s chat', (_, chat) => {
    expect(roundTrip(runChatSchema, chat)).toEqual(chat);
  });

  it.each(CHAT_CLOSE_REASONS)('takes the close reason %s', (reason) => {
    expect(runChatSchema.parse({ ...unanswered, reason })).toMatchObject({ reason });
  });

  it('holds each status to its fields', () => {
    // Pending: no answer, reason or close time yet.
    expect(() => runChatSchema.parse({ ...pendingChatFixture, answer: 'early' })).toThrow();
    expect(() =>
      runChatSchema.parse({ ...pendingChatFixture, closedAt: unanswered.closedAt }),
    ).toThrow();
    // Answered: an answer and no reason.
    expect(() => runChatSchema.parse({ ...answeredChatFixture, answer: null })).toThrow();
    expect(() => runChatSchema.parse({ ...answeredChatFixture, answer: '' })).toThrow();
    expect(() => runChatSchema.parse({ ...answeredChatFixture, reason: 'no_answer' })).toThrow();
    // Unanswered: a known reason and no answer.
    expect(() => runChatSchema.parse({ ...unanswered, reason: 'bored' })).toThrow();
    expect(() => runChatSchema.parse({ ...unanswered, answer: 'late' })).toThrow();
  });

  it('caps the message and the answer', () => {
    const long = (n: number) => 'x'.repeat(n);
    expect(() =>
      runChatSchema.parse({ ...pendingChatFixture, message: long(MAX_CHAT_CHARS + 1) }),
    ).toThrow();
    expect(() =>
      runChatSchema.parse({ ...answeredChatFixture, answer: long(MAX_CHAT_ANSWER_CHARS + 1) }),
    ).toThrow();
    expect(
      runChatSchema.parse({ ...answeredChatFixture, answer: long(MAX_CHAT_ANSWER_CHARS) }),
    ).toBeDefined();
  });

  it('keeps pending and closed apart for the two UI events', () => {
    expect(() => pendingChatSchema.parse(answeredChatFixture)).toThrow();
    expect(() => closedChatSchema.parse(pendingChatFixture)).toThrow();
    expect(() => serverToUiEvents['run.chat.asked'].parse({ v: 1, chat: unanswered })).toThrow();
    expect(() =>
      serverToUiEvents['run.chat.reply'].parse({ v: 1, chat: pendingChatFixture }),
    ).toThrow();
  });
});

describe('run.chat from a tab', () => {
  const ask = uiToServerEvents['run.chat'];
  const base = uiToServerEventFixtures['run.chat'];

  it('trims the message and refuses an empty one', () => {
    expect(ask.parse({ ...base, message: '  why?  ' }).message).toBe('why?');
    expect(() => ask.parse({ ...base, message: '   ' })).toThrow();
  });

  it(`refuses a message over ${MAX_CHAT_CHARS} characters`, () => {
    expect(ask.parse({ ...base, message: 'x'.repeat(MAX_CHAT_CHARS) })).toBeDefined();
    expect(() => ask.parse({ ...base, message: 'x'.repeat(MAX_CHAT_CHARS + 1) })).toThrow();
  });

  it('carries no sender: the server takes it from the socket', () => {
    expect(() => ask.parse({ ...base, from: 'someone-else' })).toThrow();
  });
});

describe('run.chat to a daemon', () => {
  it('needs the stored id and the sender to show the agent', () => {
    const chat = serverToNodeEvents['run.chat'];
    const { chatId, from, ...rest } = serverToNodeEventFixtures['run.chat'];
    expect(() => chat.parse({ ...rest, from })).toThrow();
    expect(() => chat.parse({ ...rest, chatId })).toThrow();
    expect(() => chat.parse({ ...rest, chatId, from: '' })).toThrow();
  });
});

describe('node.chat.reply', () => {
  const reply = nodeToServerEvents['node.chat.reply'];
  const base = nodeToServerEventFixtures['node.chat.reply'];

  it('takes an answer, or a reason for none', () => {
    const { chatId, runId } = base;
    expect(
      reply.parse({ v: 1, chatId, runId, status: 'unanswered', reason: 'queue_full' }),
    ).toEqual({
      v: 1,
      chatId,
      runId,
      status: 'unanswered',
      reason: 'queue_full',
    });
    expect(() => reply.parse({ ...base, answer: '' })).toThrow();
    expect(() => reply.parse({ ...base, answer: 'x'.repeat(MAX_CHAT_ANSWER_CHARS + 1) })).toThrow();
    expect(() => reply.parse({ v: 1, chatId, runId, status: 'unanswered' })).toThrow();
  });
});
