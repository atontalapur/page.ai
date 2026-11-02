-- The steps table as packages/contracts `stepSchema` describes it. Stands in for the
-- orchestrator migration until #25 adds steps there; switch the integration test to that
-- migration then.
create table steps (
  run_id uuid not null,
  seq integer not null check (seq >= 0),
  kind text not null check (kind in ('exec', 'edit', 'host_tool')),
  input text not null,
  output_trimmed text not null default '',
  exit_code integer,
  allowed boolean not null,
  created_at timestamptz not null default now(),
  primary key (run_id, seq)
);
