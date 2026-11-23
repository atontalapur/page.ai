import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { BotIcon } from '@solar-icons/react/bold-duotone';
import { MAX_CHAT_CHARS, type IssueRun, type RunChat } from '@page/contracts';
import { Button } from '@page/design-system/components/ui/button';
import { Label } from '@page/design-system/components/ui/label';
import { Textarea } from '@page/design-system/components/ui/textarea';

import { useAgents, useIssues } from '../../context/IssuesContext';
import { ASK_FAILURE_TEXT, chatStatus, heldByDaemon } from '../../lib/runChat';
import { clockTime } from '../../lib/runSteps';
import { isFinished } from '../../live/runs';
import type { AskFailure } from '../../live/source';
import AgentText from './AgentText';
import { NameForm } from './ApprovalRequests';
import { Enter } from './threadMotion';

/**
 * A person's message to the agent and its answer, in the run's steps after the step it
 * followed. Until the agent's next step it says it is waiting; a message with no answer
 * says why.
 */
export function ChatItem({ chat }: { chat: RunChat }) {
  const who = chat.askedBy.replace(/^ui:/, '');
  const status = chatStatus(chat);
  return (
    <Enter item label={`Message from ${who}`}>
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{who}</span>
          {' · '}
          {clockTime(chat.askedAt)}
        </p>
        <p className="whitespace-pre-wrap break-words text-sm">{chat.message}</p>
        {chat.status === 'answered' ? (
          <div className="space-y-1">
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <BotIcon className="size-3.5" />
              Answered at {clockTime(chat.closedAt)}
            </p>
            <AgentText
              text={chat.answer}
              className="max-w-prose space-y-2 text-sm leading-relaxed"
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{status}</p>
        )}
      </div>
    </Enter>
  );
}

/**
 * A box to send the agent a message on a run in progress: a question about what it is doing,
 * or a pointer. The agent reads it before its next step and answers in that step, and every
 * open tab shows both. It is shut, with the reason, while the run has ended, no daemon holds
 * it, or this tab is not connected.
 *
 * The message is recorded under the identity a Tier 3 decision gets (ApprovalRequests): a
 * personal token's person; nobody for the shared token once personal tokens are configured,
 * so the box is shut for it; and otherwise a name the tab gives, which it asks for first.
 */
export function AskAgent({ run }: { run: Pick<IssueRun, 'id' | 'status'> }) {
  const { askAgent, approverName, setApproverName, status, session, signOut } = useIssues();
  const { nodes } = useAgents();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<AskFailure | undefined>();
  const [renaming, setRenaming] = useState(false);
  const id = useId();

  const signedIn = session?.token === 'personal' ? session.name : undefined;
  const sharedOnly = session?.token === 'shared' && !session.canDecide;
  const shut = isFinished(run)
    ? 'This run has ended, so it takes no more messages.'
    : status !== 'live'
      ? 'Not connected to the orchestrator, so no message can go out from this tab until it is back.'
      : !heldByDaemon(nodes, run.id)
        ? 'No agent daemon holds this run right now. You can send a message once one takes it.'
        : sharedOnly
          ? "This tab connected with the shared API token, which can't send the agent messages."
          : undefined;
  const naming = signedIn === undefined && !sharedOnly && (approverName === null || renaming);
  const sender = signedIn ?? approverName;
  const message = text.trim();
  const canSend = shut === undefined && !naming && !sending && message !== '';

  async function send() {
    if (!canSend) return;
    setSending(true);
    setFailure(undefined);
    const failed = await askAgent(run.id, message);
    setSending(false);
    if (failed === undefined) setText('');
    else setFailure(failed);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void send();
  }

  // Enter adds a line; Cmd or Ctrl with Enter sends.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <section aria-label="Ask the agent" className="space-y-3 border-t px-4 py-4">
      {naming && shut === undefined ? (
        <NameForm
          hint="Your messages to the agent are recorded under this name."
          onSave={(name) => {
            setApproverName(name);
            setRenaming(false);
          }}
        />
      ) : null}
      <form onSubmit={submit} className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Label htmlFor={id}>Ask the agent</Label>
          {sharedOnly ? (
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={signOut}
            >
              Connect with your personal token
            </button>
          ) : (
            sender !== null &&
            !naming && (
              <p className="text-xs text-muted-foreground">
                As <span className="font-medium text-foreground">{sender}</span>.
                {signedIn === undefined && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="font-medium text-primary hover:underline"
                      onClick={() => setRenaming(true)}
                    >
                      Change
                    </button>
                  </>
                )}
              </p>
            )
          )}
        </div>
        <Textarea
          id={id}
          value={text}
          rows={2}
          maxLength={MAX_CHAT_CHARS}
          disabled={shut !== undefined || sending}
          placeholder="Why that file? Did you check the config?"
          aria-describedby={`${id}-hint`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p id={`${id}-hint`} className="max-w-prose text-xs text-muted-foreground">
            {shut ??
              "The agent reads your message before its next step and answers in that step, without stopping. It is guidance only: the run's tier, policy and approvals still decide what it may do."}
          </p>
          <div className="flex items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">
              {`${text.length}/${MAX_CHAT_CHARS}`}
            </span>
            <Button type="submit" size="sm" disabled={!canSend}>
              {sending ? 'Sending...' : 'Send'}
            </Button>
          </div>
        </div>
        {failure !== undefined && (
          <p role="alert" className="text-xs text-red-11">
            {ASK_FAILURE_TEXT[failure]}
          </p>
        )}
      </form>
    </section>
  );
}
