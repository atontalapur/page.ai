import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  issueRunSchema,
  MAX_CHAT_CHARS,
  NODE_NAMESPACE,
  serverToNodeEvents,
  serverToUiEvents,
  UI_NAMESPACE,
  type ClosedChat,
  type PendingChat,
  type ServerToNodeEvents,
} from '@page/contracts';
import { stepFixture } from '@page/contracts/fixtures';
import type { Socket } from 'socket.io-client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { Nodes } from '../gateway/nodes.ts';
import { MAX_CHATS_PER_RUN } from '../gateway/run-chats.ts';
import { outcome, TestSockets } from '../gateway/test-utils.ts';
import { CHATS_PER_MINUTE } from '../gateway/ui.gateway.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { ChatsService } from './chats.service.ts';

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(deps, false);
await app.listen({ port: 0, host: '127.0.0.1' });
const base = await app.getUrl();
afterAll(async () => {
  await app.close();
  await deps.close();
});

const nodeSockets = new TestSockets(`${base}${NODE_NAMESPACE}`, '192.0.2');
const tabs = new TestSockets(`${base}${UI_NAMESPACE}`, '203.0.113');
afterEach(() => {
  nodeSockets.closeAll();
  tabs.closeAll();
  vi.restoreAllMocks();
});

const issues = app.get(IssuesService);
const chats = app.get(ChatsService);
const nodes = app.get(Nodes);
let n = 0;

/** An issue in `fixing`, and the run its fix job carries. */
async function fixing(): Promise<{ issueId: string; runId: string }> {
  const { issue } = await issues.report(
    { fingerprint: `chats-${++n}`, title: 'Boom' },
    'GET /\n\nTypeError: boom',
  );
  await issues.apply(issue.id, { type: 'triage', class: 'frontend', severity: 'low' });
  await issues.apply(issue.id, { type: 'start_fix' });
  const row = await deps.db
    .selectFrom('issues')
    .select('current_run_id')
    .where('id', '=', issue.id)
    .executeTakeFirstOrThrow();
  return { issueId: issue.id, runId: row.current_run_id ?? '' };
}

async function connected(socket: Socket): Promise<Socket> {
  expect(await outcome(socket)).toBe('connected');
  return socket;
}

const tab = (name?: string) =>
  connected(tabs.connect({ token: testConfig.apiToken, ...(name === undefined ? {} : { name }) }));

type NodeChat = Parameters<ServerToNodeEvents['run.chat']>[0];

/** A daemon that holds `runId` from its first step, and the messages it gets. */
async function holding(runId: string) {
  const socket = await connected(nodeSockets.connect({ token: testConfig.nodeSharedSecret }));
  const got: NodeChat[] = [];
  socket.on('run.chat', (payload: unknown) =>
    got.push(serverToNodeEvents['run.chat'].parse(payload)),
  );
  socket.emit('node.step', { v: 1, step: { ...stepFixture, runId, seq: 0 } });
  await expect.poll(() => nodes.holder(runId)).toBeDefined();
  return { socket, got };
}

/** What a tab hears about messages, each parsed against its contract as the UI parses it. */
function listen(socket: Socket) {
  const asked: PendingChat[] = [];
  const replies: ClosedChat[] = [];
  const refused: { runId: string; reason: string }[] = [];
  socket.on('run.chat.asked', (p: unknown) =>
    asked.push(serverToUiEvents['run.chat.asked'].parse(p).chat),
  );
  socket.on('run.chat.reply', (p: unknown) =>
    replies.push(serverToUiEvents['run.chat.reply'].parse(p).chat),
  );
  socket.on('run.chat.refused', (p: unknown) => {
    const { runId, reason } = serverToUiEvents['run.chat.refused'].parse(p);
    refused.push({ runId, reason });
  });
  return { asked, replies, refused };
}

const ask = (socket: Socket, runId: string, message = 'Why the config?') =>
  socket.emit('run.chat', { v: 1, runId, message });

const rows = (runId: string) =>
  deps.db.selectFrom('run_chats').selectAll().where('run_id', '=', runId).execute();

describe('a tab sends a run a message', () => {
  it('sends it to the daemon holding the run and no other, and shows it to every tab', async () => {
    const first = await fixing();
    const second = await fixing();
    const a = await holding(first.runId);
    const b = await holding(second.runId);
    const arjun = await tab('Arjun');
    const daniyal = await tab('Daniyal');
    const heard = [listen(arjun), listen(daniyal)];

    ask(arjun, second.runId, '  Why the config?  ');

    await expect.poll(() => b.got).toHaveLength(1);
    const [chat] = b.got;
    expect(chat).toEqual({
      v: 1,
      chatId: expect.any(String) as string,
      runId: second.runId,
      from: 'Arjun',
      message: 'Why the config?',
    });
    for (const tabHeard of heard) {
      await expect
        .poll(() => tabHeard.asked)
        .toMatchObject([
          {
            id: chat!.chatId,
            runId: second.runId,
            issueId: second.issueId,
            askedBy: 'ui:Arjun',
            message: 'Why the config?',
            status: 'pending',
          },
        ]);
    }
    expect(a.got).toEqual([]);
    expect(heard[0]!.refused).toEqual([]);
  });

  it('stores the answer, sends it to every tab, and serves it with the run', async () => {
    const { issueId, runId } = await fixing();
    const daemon = await holding(runId);
    const arjun = await tab('Arjun');
    const watcher = listen(await tab('Daniyal'));
    ask(arjun, runId);
    await expect.poll(() => daemon.got).toHaveLength(1);
    const { chatId } = daemon.got[0]!;

    daemon.socket.emit('node.chat.reply', {
      v: 1,
      chatId,
      runId,
      status: 'answered',
      answer: 'The stack trace points at the config read.',
    });

    await expect
      .poll(() => watcher.replies)
      .toMatchObject([
        { id: chatId, status: 'answered', answer: 'The stack trace points at the config read.' },
      ]);
    const res = await app.inject({
      method: 'GET',
      url: `/issues/${issueId}/runs`,
      headers: { authorization: `Bearer ${testConfig.apiToken}` },
    });
    const [run] = issueRunSchema.array().parse(res.json());
    expect(run?.chats).toMatchObject([{ id: chatId, askedBy: 'ui:Arjun', status: 'answered' }]);
  });

  it('keeps the first answer, and drops a reply for another run', async () => {
    const { runId } = await fixing();
    const daemon = await holding(runId);
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, runId);
    await expect.poll(() => daemon.got).toHaveLength(1);
    const { chatId } = daemon.got[0]!;

    daemon.socket.emit('node.chat.reply', {
      v: 1,
      chatId,
      runId: randomUUID(),
      status: 'answered',
      answer: 'wrong run',
    });
    daemon.socket.emit('node.chat.reply', {
      v: 1,
      chatId,
      runId,
      status: 'unanswered',
      reason: 'no_answer',
    });
    daemon.socket.emit('node.chat.reply', {
      v: 1,
      chatId,
      runId,
      status: 'answered',
      answer: 'late',
    });
    // A later event from the same socket is handled after the replies.
    daemon.socket.emit('node.diff', { v: 1, runId, diff: '' });

    await expect.poll(() => heard.replies).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard.replies).toMatchObject([
      { id: chatId, status: 'unanswered', reason: 'no_answer' },
    ]);
    expect(await rows(runId)).toMatchObject([
      { status: 'unanswered', reason: 'no_answer', answer: null },
    ]);
  });
});

describe('a message the server turns away', () => {
  it('tells only the tab that sent it when no daemon holds the run, and stores nothing', async () => {
    const { runId } = await fixing();
    const arjun = await tab('Arjun');
    const daniyal = listen(await tab('Daniyal'));
    const heard = listen(arjun);
    ask(arjun, runId);
    await expect.poll(() => heard.refused).toEqual([{ runId, reason: 'no_daemon' }]);
    expect(daniyal.refused).toEqual([]);
    expect(daniyal.asked).toEqual([]);
    expect(await rows(runId)).toEqual([]);
  });

  it('refuses a run that is not in progress', async () => {
    const { issueId, runId } = await fixing();
    const daemon = await holding(runId);
    await issues.apply(issueId, { type: 'kill' });
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, runId);
    ask(arjun, randomUUID());
    await expect
      .poll(() => heard.refused.map((r) => r.reason))
      .toEqual(['not_in_progress', 'not_in_progress']);
    expect(daemon.got).toEqual([]);
  });

  it('refuses a tab that connected with no name, or one it may not use', async () => {
    const { runId } = await fixing();
    const daemon = await holding(runId);
    const nameless = await tab();
    const posing = await tab('system:timed_out');
    const heard = [listen(nameless), listen(posing)];
    ask(nameless, runId);
    ask(posing, runId);
    for (const tabHeard of heard) {
      await expect.poll(() => tabHeard.refused).toEqual([{ runId, reason: 'no_name' }]);
    }
    expect(daemon.got).toEqual([]);
  });

  it(`refuses a tab's messages past ${CHATS_PER_MINUTE} a minute, and keeps it open`, async () => {
    const { runId } = await fixing();
    const daemon = await holding(runId);
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    for (let i = 0; i <= CHATS_PER_MINUTE; i++) ask(arjun, runId, `question ${i}`);
    await expect.poll(() => heard.refused).toEqual([{ runId, reason: 'rate_limited' }]);
    await expect.poll(() => daemon.got).toHaveLength(CHATS_PER_MINUTE);
    expect(arjun.connected).toBe(true);
    // Counted per tab: another one can still ask.
    const daniyal = await tab('Daniyal');
    ask(daniyal, runId, 'one more');
    await expect.poll(() => daemon.got).toHaveLength(CHATS_PER_MINUTE + 1);
  });

  it(`refuses a run past ${MAX_CHATS_PER_RUN} messages, from every tab together`, async () => {
    const { issueId, runId } = await fixing();
    const daemon = await holding(runId);
    for (let i = 0; i < MAX_CHATS_PER_RUN; i++) {
      await chats.ask({ runId, issueId, askedBy: 'ui:Arjun', message: `question ${i}` });
    }
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, runId);
    await expect.poll(() => heard.refused).toEqual([{ runId, reason: 'too_many' }]);
    expect(daemon.got).toEqual([]);
    expect(await rows(runId)).toHaveLength(MAX_CHATS_PER_RUN);
  });

  it(`drops a message over ${MAX_CHAT_CHARS} characters as a broken contract`, async () => {
    const { runId } = await fixing();
    const daemon = await holding(runId);
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, runId, 'x'.repeat(MAX_CHAT_CHARS + 1));
    ask(arjun, runId, 'x'.repeat(MAX_CHAT_CHARS));
    await expect.poll(() => daemon.got).toHaveLength(1);
    expect(daemon.got[0]?.message).toHaveLength(MAX_CHAT_CHARS);
    expect(heard.refused).toEqual([]);
    expect(await rows(runId)).toHaveLength(1);
  });

  it('closes a message as no_daemon when the daemon leaves before it goes out', async () => {
    const { runId } = await fixing();
    const daemon = await holding(runId);
    vi.spyOn(nodes, 'send').mockReturnValueOnce(false);
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, runId);
    await expect
      .poll(() => heard.replies)
      .toMatchObject([{ runId, status: 'unanswered', reason: 'no_daemon' }]);
    expect(heard.asked).toHaveLength(1);
    expect(daemon.got).toEqual([]);
  });
});

describe('the server closes a message', () => {
  async function waiting() {
    const run = await fixing();
    const daemon = await holding(run.runId);
    const arjun = await tab('Arjun');
    const heard = listen(arjun);
    ask(arjun, run.runId);
    await expect.poll(() => daemon.got).toHaveLength(1);
    return { ...run, daemon, heard };
  }

  it('as run_ended when its run finishes before the daemon answers', async () => {
    const { runId, daemon, heard } = await waiting();
    daemon.socket.emit('node.run.finished', {
      v: 1,
      runId,
      status: 'failed',
      prUrl: null,
      confidence: null,
      note: null,
    });
    await expect
      .poll(() => heard.replies)
      .toMatchObject([{ runId, status: 'unanswered', reason: 'run_ended' }]);
  });

  it('as run_ended when the issue is killed or moves to the next tier', async () => {
    const killed = await waiting();
    await issues.apply(killed.issueId, { type: 'kill' });
    await expect
      .poll(() => killed.heard.replies)
      .toMatchObject([{ status: 'unanswered', reason: 'run_ended' }]);

    const escalated = await waiting();
    await issues.apply(escalated.issueId, {
      type: 'escalate',
      runId: escalated.runId,
      reason: 'needs_higher_tier: x',
    });
    await expect.poll(async () => (await rows(escalated.runId))[0]?.reason).toBe('run_ended');
  });

  it('logs a listener that throws, and still tells the others', async () => {
    const unsubscribe = chats.subscribe(() => {
      throw new Error('boom');
    });
    try {
      const { runId, daemon, heard } = await waiting();
      daemon.socket.emit('node.chat.reply', {
        v: 1,
        chatId: daemon.got[0]!.chatId,
        runId,
        status: 'answered',
        answer: 'Still here.',
      });
      await expect.poll(() => heard.replies).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('logs a close that fails from an issue change', async () => {
    const error = vi.spyOn(deps.logger, 'error');
    vi.spyOn(chats, 'close').mockRejectedValueOnce(new Error('db down'));
    const { issueId } = await fixing();
    await issues.apply(issueId, { type: 'kill' });
    await expect
      .poll(() => error.mock.calls.map((call) => call[1]))
      .toContain('could not close the messages of a run that ended');
  });
});
