create table issues (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null,
  title text not null,
  status text not null default 'new' check (
    status in ('new', 'triaged', 'fixing', 'pr_open', 'awaiting_approval', 'resolved', 'failed', 'killed')
  ),
  class text check (class in ('frontend', 'backend-api', 'database', 'infra-config')),
  severity text check (severity in ('low', 'medium', 'high', 'critical')),
  current_tier smallint check (current_tier between 1 and 3),
  occurrences integer not null default 1 check (occurrences > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- One open issue per fingerprint. A recurrence after a terminal status opens a new issue.
create unique index issues_open_fingerprint on issues (fingerprint)
  where status not in ('resolved', 'failed', 'killed');

create index issues_updated_at on issues (updated_at desc);

create table issue_events (
  id bigint generated always as identity primary key,
  issue_id uuid not null references issues (id) on delete cascade,
  event jsonb not null,
  from_status text not null,
  to_status text not null,
  current_tier smallint,
  created_at timestamptz not null default now()
);

create index issue_events_issue_id on issue_events (issue_id, id);
