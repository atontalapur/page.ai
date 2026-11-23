-- Messages people on call send a run in progress from the dashboard, and the agent's answers
-- (contracts runChatSchema). The orchestrator stores a message when it sends it to the daemon
-- holding the run, and the answer, or why there is none, when the daemon reports it.
--
-- run_id is the fix job's id with no foreign key, as for steps and approvals: a run has no
-- runs row until its result is recorded, and that is when people ask. issue_id references
-- the issue instead, so an issue with messages can't be deleted. The CHECK lists copy
-- CHAT_STATUSES and CHAT_CLOSE_REASONS, and the length caps MAX_CHAT_CHARS and
-- MAX_CHAT_ANSWER_CHARS; apps/orchestrator/src/db/schema.test.ts fails when they drift apart.
create table run_chats (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  issue_id uuid not null references issues (id) on delete restrict,
  -- Set from the asking socket's identity, never from a client payload.
  asked_by text not null check (asked_by <> ''),
  message text not null check (message <> '' and char_length(message) <= 1000),
  asked_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'answered', 'unanswered')),
  answer text check (answer <> '' and char_length(answer) <= 4000),
  reason text check (
    reason in ('queue_full', 'submitted', 'run_ended', 'no_answer', 'no_daemon')
  ),
  closed_at timestamptz,
  -- A pending message has no answer, reason or close time; an answered one has its answer, an
  -- unanswered one its reason, and both a close time.
  check ((status = 'pending') = (closed_at is null)),
  check ((status = 'answered') = (answer is not null)),
  check ((status = 'unanswered') = (reason is not null))
);

create index run_chats_run_id on run_chats (run_id, asked_at);
create index run_chats_pending on run_chats (issue_id) where status = 'pending';
