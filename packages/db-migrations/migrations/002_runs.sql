-- Runs, their steps, escalations and approvals, as the row schemas in
-- packages/contracts/src/db.ts describe them. The CHECK lists copy the contracts enums;
-- apps/orchestrator/src/db/schema.test.ts fails when they drift apart.
--
-- These tables are the audit record: what ran, what escalated, who approved an ops action.
-- They don't cascade on delete, so an issue with runs, or a run with escalations or
-- approvals, can't be deleted and the record can't be lost by accident.

-- One fix attempt at one tier. The id is the fix job's pg-boss id (issues.current_run_id).
create table runs (
  id uuid primary key,
  issue_id uuid not null references issues (id) on delete restrict,
  tier smallint not null check (tier between 1 and 3),
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'escalated', 'failed', 'killed')
  ),
  started_at timestamptz,
  finished_at timestamptz,
  pr_url text,
  -- Null until the run scores itself (contracts confidenceSchema).
  confidence jsonb check (jsonb_typeof(confidence) = 'object'),
  created_at timestamptz not null default now()
);

create index runs_issue_id on runs (issue_id, created_at);

-- One execute() call (#3), refused ones included. No foreign key to runs: the daemon writes
-- a step before every command runs, and that write must not fail on a missing run row. A run
-- with steps can still be deleted directly, which leaves its steps behind.
create table steps (
  run_id uuid not null,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('exec', 'edit', 'host_tool')),
  input text not null,
  output_trimmed text not null default '',
  -- Null when the command was refused or timed out.
  exit_code integer,
  allowed boolean not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete restrict,
  from_tier smallint not null check (from_tier between 1 and 3),
  to_tier smallint not null check (to_tier between 1 and 3),
  reason text not null check (
    reason in ('needs_higher_tier', 'tests_failing', 'budget_exhausted', 'agent_error')
  ),
  -- contracts escalationNoteSchema
  note jsonb not null check (jsonb_typeof(note) = 'object'),
  created_at timestamptz not null default now(),
  check (to_tier > from_tier)
);

create index escalations_run_id on escalations (run_id);

create table approvals (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs (id) on delete restrict,
  -- The host tool the agent wants to run, e.g. ops.restart, and its arguments.
  action text not null check (action <> ''),
  args jsonb not null default '{}' check (jsonb_typeof(args) = 'object'),
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  -- Set from the deciding socket's identity, never from a client payload.
  decided_by text check (decided_by <> ''),
  decided_at timestamptz,
  requested_at timestamptz not null default now(),
  -- A pending approval has no decider and no time; a decided one has both.
  check ((decision = 'pending') = (decided_by is null and decided_at is null)),
  check ((decided_by is null) = (decided_at is null))
);

create index approvals_pending on approvals (requested_at) where decision = 'pending';
create index approvals_run_id on approvals (run_id);
