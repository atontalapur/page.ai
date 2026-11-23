// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { IssueRun, RunChat, Step } from '@page/contracts';

import IncidentDetailsPage from '../../pages/IncidentDetailsPage';
import {
  daemon,
  issue,
  nodeRun,
  renderWithIssues,
  testSource,
  type TestSource,
  withSession,
} from '../../test-utils';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('page-ai-approver-name', 'Arjun');
});
afterEach(() => {
  cleanup();
});

const fixing = issue(1, { status: 'fixing', currentTier: 1 });
const runId = '10000000-2222-4222-8222-222222222222';
const at = (s: number) => `2026-11-22T09:00:${String(s).padStart(2, '0')}.000Z`;

function run(fields: Partial<IssueRun> = {}): IssueRun {
  return {
    id: runId,
    issueId: fixing.id,
    tier: 1,
    status: 'running',
    startedAt: at(0),
    finishedAt: null,
    prUrl: null,
    confidence: null,
    diff: null,
    steps: [step(0, 'ls -la', 0), step(1, 'git diff', 20)],
    chats: [],
    ...fields,
  };
}

function step(seq: number, input: string, s: number): Step {
  return {
    runId,
    seq,
    kind: 'exec',
    input,
    outputTrimmed: '',
    exitCode: 0,
    allowed: true,
    thought: null,
    createdAt: at(s),
  };
}

const pending = (fields: Partial<RunChat> = {}): RunChat =>
  ({
    id: 'c5e3a9b7-1d2f-4c6e-9a8b-000000000001',
    runId,
    issueId: fixing.id,
    askedBy: 'ui:Dana',
    message: 'Why are you reading git diff?',
    askedAt: at(10),
    status: 'pending',
    answer: null,
    reason: null,
    closedAt: null,
    ...fields,
  }) as RunChat;

const answered = (fields: Partial<RunChat> = {}) =>
  pending({
    status: 'answered',
    answer: 'To see what the last deploy changed.',
    closedAt: at(25),
    ...fields,
  } as Partial<RunChat>);

/** A daemon that holds the run, as GET /nodes would list it. */
const holder = () => daemon('node-1', { current: [{ ...nodeRun(1, fixing), id: runId }] });

function render(
  runs: IssueRun[],
  { held = true, source }: { held?: boolean; source?: TestSource } = {},
) {
  const src = source ?? testSource([fixing], 'live', held ? [holder()] : []);
  src.runs.set(fixing.id, runs);
  renderWithIssues(<IncidentDetailsPage />, src, {
    path: `/incidents/${fixing.id}`,
    route: '/incidents/:id',
  });
  return src;
}

const box = () => screen.findByRole('textbox', { name: 'Ask the agent' });
const sendButton = () => screen.getByRole('button', { name: 'Send' });

describe('the conversation on a run', () => {
  it('shows a message after the step it followed, and its answer, as they arrive', async () => {
    const source = render([run()]);
    expect(await screen.findByText('$ git diff')).toBeTruthy();
    const loads = source.loads.runs;

    source.sendRun('run.chat.asked', { v: 1, chat: pending() });
    const item = await screen.findByRole('listitem', { name: 'Message from Dana' });
    expect(within(item).getByText('Why are you reading git diff?')).toBeTruthy();
    expect(within(item).getByText("Waiting for the agent's next step.")).toBeTruthy();
    // In order with the steps: after step 0, which started before it was asked, and before 1.
    const steps = screen.getByRole('list', { name: 'Tier 1 steps' });
    const order = within(steps)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label') ?? li.querySelector('code')?.textContent);
    expect(order).toEqual(['$ ls -la', 'Message from Dana', '$ git diff']);

    source.sendRun('run.chat.reply', { v: 1, chat: answered() });
    expect(await within(item).findByText('To see what the last deploy changed.')).toBeTruthy();
    expect(within(item).queryByText("Waiting for the agent's next step.")).toBeNull();
    // A pending copy that comes late doesn't take the answer back.
    source.sendRun('run.chat.asked', { v: 1, chat: pending() });
    expect(within(item).getByText('To see what the last deploy changed.')).toBeTruthy();
    // No reload was needed.
    expect(source.loads.runs).toBe(loads);
  });

  it('says why a message got no answer, and shows one asked before the first step on top', async () => {
    render([
      run({
        chats: [
          pending({
            id: 'c5e3a9b7-1d2f-4c6e-9a8b-000000000002',
            askedAt: '2026-11-22T08:59:59.000Z',
            message: 'Start with the config.',
            status: 'unanswered',
            reason: 'queue_full',
            closedAt: at(1),
          }),
          pending({
            status: 'unanswered',
            reason: 'no_answer',
            closedAt: at(25),
          }),
        ],
      }),
    ]);
    const early = await screen.findByRole('list', { name: 'Messages before the first step' });
    expect(within(early).getByText('Start with the config.')).toBeTruthy();
    expect(
      within(early).getByText('Not read: too many messages were already waiting for the agent.'),
    ).toBeTruthy();
    expect(screen.getByText('The agent read this and did not answer.')).toBeTruthy();
  });

  it('ignores a message for another run', async () => {
    const source = render([run()]);
    expect(await screen.findByText('$ git diff')).toBeTruthy();
    source.sendRun('run.chat.asked', {
      v: 1,
      chat: pending({ runId: '90000000-2222-4222-8222-222222222222' }),
    });
    expect(screen.queryByRole('listitem', { name: 'Message from Dana' })).toBeNull();
  });
});

describe('the box to ask the agent', () => {
  it('sends the message for the run and clears the box', async () => {
    const source = render([run()]);
    fireEvent.change(await box(), { target: { value: '  Why git diff?  ' } });
    expect(screen.getByText('17/1000')).toBeTruthy();
    await act(async () => {
      fireEvent.click(sendButton());
      await Promise.resolve();
    });
    expect(source.asks).toEqual([{ runId, message: 'Why git diff?' }]);
    expect(((await box()) as HTMLTextAreaElement).value).toBe('');
  });

  it('sends with Cmd or Ctrl and Enter, and not with Enter alone', async () => {
    const source = render([run()]);
    const input = await box();
    fireEvent.change(input, { target: { value: 'Still on it?' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(source.asks).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
      await Promise.resolve();
    });
    expect(source.asks).toEqual([{ runId, message: 'Still on it?' }]);
  });

  it('says why a message was turned away, and keeps the text', async () => {
    const source = testSource([fixing], 'live', [holder()]);
    source.askFailure = 'too_many';
    render([run()], { source });
    fireEvent.change(await box(), { target: { value: 'One more?' } });
    await act(async () => {
      fireEvent.click(sendButton());
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'This run has had as many messages as one run takes.',
    );
    expect(((await box()) as HTMLTextAreaElement).value).toBe('One more?');
  });

  it("starts empty for the next run, with neither the last one's draft nor its error", async () => {
    const source = testSource([fixing], 'live', [holder()]);
    source.askFailure = 'rate_limited';
    render([run()], { source });
    fireEvent.change(await box(), { target: { value: 'Draft for tier 1' } });
    await act(async () => {
      fireEvent.click(sendButton());
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toBeTruthy();

    const next = '20000000-2222-4222-8222-222222222222';
    source.sendRun('run.started', {
      v: 1,
      run: {
        id: next,
        issueId: fixing.id,
        tier: 2,
        status: 'running',
        startedAt: at(40),
        finishedAt: null,
        prUrl: null,
        confidence: null,
      },
    });
    expect(await screen.findByText('Tier 2')).toBeTruthy();
    expect(((await box()) as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends as the person a personal token names, with no name to give or change', async () => {
    localStorage.clear();
    const source = withSession(testSource([fixing], 'live', [holder()]), {
      token: 'personal',
      name: 'Daniyal',
    });
    render([run()], { source });
    fireEvent.change(await box(), { target: { value: 'Why git diff?' } });
    const section = screen.getByRole('region', { name: 'Ask the agent' });
    expect(await within(section).findByText('Daniyal')).toBeTruthy();
    expect(within(section).queryByLabelText('Your name')).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Change' })).toBeNull();
    await act(async () => {
      fireEvent.click(sendButton());
      await Promise.resolve();
    });
    expect(source.asks).toEqual([{ runId, message: 'Why git diff?' }]);
  });

  it('is shut for the shared token once personal tokens exist, and offers the switch', async () => {
    const source = withSession(testSource([fixing], 'live', [holder()]), {
      token: 'shared',
      canDecide: false,
    });
    render([run()], { source });
    expect(
      await screen.findByText(
        "This tab connected with the shared API token, which can't send the agent messages.",
      ),
    ).toBeTruthy();
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Your name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect with your personal token' }));
    expect(await screen.findByLabelText('Personal or API token')).toBeTruthy();
  });

  it('asks for a name first, and sends nothing until there is one', async () => {
    localStorage.clear();
    const source = render([run()]);
    fireEvent.change(await box(), { target: { value: 'Hello?' } });
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(/Your messages to the agent are recorded under this name/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Dana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(source.names).toEqual(['Dana']);
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('Dana')).toBeTruthy();
  });

  it('is shut while no daemon holds the run', async () => {
    render([run()], { held: false });
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/No agent daemon holds this run right now/)).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('is shut while the tab is not connected', async () => {
    const source = render([run()]);
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(false);
    source.setStatus('reconnecting');
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/Not connected to the orchestrator/)).toBeTruthy();
  });

  it('is shut once the run ends, and left out of an ended run nobody talked to', async () => {
    const source = render([run()]);
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(false);
    source.sendRun('run.chat.asked', { v: 1, chat: pending() });
    source.sendRun('run.finished', {
      v: 1,
      run: {
        id: runId,
        issueId: fixing.id,
        tier: 1,
        status: 'killed',
        startedAt: at(0),
        finishedAt: at(30),
        prUrl: null,
        confidence: null,
      },
      note: null,
    });
    expect(
      await screen.findByText('This run has ended, so it takes no more messages.'),
    ).toBeTruthy();
    expect(((await box()) as HTMLTextAreaElement).disabled).toBe(true);
    cleanup();

    render([run({ status: 'succeeded', finishedAt: at(30) })]);
    expect(await screen.findByText('$ git diff')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Ask the agent' })).toBeNull();
  });

  it('shows nothing it could not send for a broken run event', async () => {
    const source = render([run()]);
    expect(await screen.findByText('$ git diff')).toBeTruthy();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    source.sendRun('run.chat.reply', { v: 1, chat: pending() });
    expect(screen.queryByRole('listitem', { name: 'Message from Dana' })).toBeNull();
  });
});
