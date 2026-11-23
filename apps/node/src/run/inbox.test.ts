import { MAX_CHAT_ANSWER_CHARS } from '@page/contracts';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { FakeLink } from '../link/fake-link.ts';
import { closeChat, MAX_WAITING_CHATS, RunInbox } from './inbox.ts';

const runId = '7c1e4a2b-5d3f-4b8a-a1c9-6e2f8d4b3a02';
const logger = pino({ enabled: false });
const chatId = (n: number) => `c5e3a9b7-1d2f-4c6e-9a8b-${n.toString().padStart(12, '0')}`;
const chat = (n: number, message = `question ${n}`) => ({
  v: 1 as const,
  chatId: chatId(n),
  runId,
  from: 'Arjun',
  message,
});

function inbox() {
  const link = new FakeLink();
  return {
    link,
    inbox: new RunInbox({ runId, link, logger }),
    replies: () => link.payloads('node.chat.reply'),
  };
}

describe('RunInbox', () => {
  it('hands each waiting message to the agent once, oldest first', () => {
    const { inbox: box, replies } = inbox();
    box.deliver(chat(1));
    box.deliver(chat(2, 'Why the config?'));
    expect(box.take()).toEqual([
      { id: chatId(1), from: 'Arjun', text: 'question 1' },
      { id: chatId(2), from: 'Arjun', text: 'Why the config?' },
    ]);
    expect(box.take()).toEqual([]);
    expect(replies()).toEqual([]);
  });

  it('sends the answer for each message the agent read', () => {
    const { inbox: box, replies } = inbox();
    box.deliver(chat(1));
    box.deliver(chat(2));
    const read = box.take();
    box.answer(read, 'Reading the config first.');
    expect(replies()).toEqual([
      { v: 1, chatId: chatId(1), runId, status: 'answered', answer: 'Reading the config first.' },
      { v: 1, chatId: chatId(2), runId, status: 'answered', answer: 'Reading the config first.' },
    ]);
    // Once each: an answer for a message already answered, or never read, is dropped.
    box.answer(read, 'again');
    box.answer([{ id: chatId(9), from: 'x', text: 'y' }], 'never read');
    expect(replies()).toHaveLength(2);
  });

  it('closes a message the agent read and did not answer as no_answer', () => {
    const { inbox: box, replies } = inbox();
    box.deliver(chat(1));
    box.answer(box.take(), null);
    expect(replies()).toEqual([
      { v: 1, chatId: chatId(1), runId, status: 'unanswered', reason: 'no_answer' },
    ]);
  });

  it(`caps an answer at ${MAX_CHAT_ANSWER_CHARS} characters`, () => {
    const { inbox: box, replies } = inbox();
    box.deliver(chat(1));
    box.answer(box.take(), 'x'.repeat(MAX_CHAT_ANSWER_CHARS + 50));
    const [reply] = replies();
    expect(reply?.status === 'answered' && reply.answer.length).toBe(MAX_CHAT_ANSWER_CHARS);
  });

  it(`closes a message past ${MAX_WAITING_CHATS} waiting as queue_full`, () => {
    const { inbox: box, replies } = inbox();
    for (let n = 1; n <= MAX_WAITING_CHATS + 1; n++) box.deliver(chat(n));
    expect(replies()).toEqual([
      {
        v: 1,
        chatId: chatId(MAX_WAITING_CHATS + 1),
        runId,
        status: 'unanswered',
        reason: 'queue_full',
      },
    ]);
    expect(box.take()).toHaveLength(MAX_WAITING_CHATS);
    // Read ones don't wait any more, so the queue has room again.
    box.deliver(chat(10));
    expect(box.take()).toHaveLength(1);
  });

  it('closes what is left when the agent stops, and anything that comes after', () => {
    const { inbox: box, replies } = inbox();
    box.deliver(chat(1));
    box.take();
    box.deliver(chat(2));
    box.end('submitted');
    box.deliver(chat(3));
    box.end('run_ended');
    expect(replies().map((r) => [r.chatId, r.status === 'unanswered' && r.reason])).toEqual([
      [chatId(2), 'submitted'],
      // Read, but the reply that would answer it never came.
      [chatId(1), 'run_ended'],
      [chatId(3), 'submitted'],
    ]);
    expect(box.take()).toEqual([]);
  });

  it('logs a reply the link refuses, and goes on', () => {
    const link = new FakeLink();
    link.send = () => {
      throw new Error('bad payload');
    };
    const errors: unknown[] = [];
    const watched = pino({ level: 'error' }, { write: (line: string) => errors.push(line) });
    expect(() => closeChat(link, chat(1), 'run_ended', watched)).not.toThrow();
    expect(String(errors[0])).toContain('could not send the reply to a message');
  });
});
