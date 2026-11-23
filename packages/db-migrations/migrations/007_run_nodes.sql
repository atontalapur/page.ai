-- Which node daemon worked each run, by the name it sends in its socket handshake
-- (contracts nodeNameSchema), for the agents page. The claim is the pg-boss fix job, which
-- doesn't say which daemon took it, so the orchestrator writes this row on the daemon's
-- first event for the run. No foreign key to runs: a run has no row until its result is
-- recorded, as with steps.
create table run_nodes (
  run_id uuid primary key,
  node_name text not null check (node_name <> ''),
  created_at timestamptz not null default now()
);

create index run_nodes_node_name on run_nodes (node_name, created_at desc);
