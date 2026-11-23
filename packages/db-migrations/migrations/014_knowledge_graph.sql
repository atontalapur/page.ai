-- The knowledge graph (graph RAG) the agents read and write, the decisions jev makes about
-- an issue, and the tier triage picks for its first fix.
--
-- Knowledge lives on a branch: `main`, or a run's `pageagents/<runId>`. A run writes only to
-- its own branch and reads it over `main`; a merged PR copies the branch onto `main`. Every
-- change is a row of kg_versions, with the commit that carried it. commit_sha is set only once
-- the commit is on the remote (a push GitHub accepted, or the merge of the PR), and never
-- changes after that; the trigger below refuses it.
--
-- Embeddings are real[] rather than pgvector's vector, so the graph needs no extension;
-- KnowledgeService ranks by cosine similarity in code, which a graph this size allows.

create table kg_nodes (
  id uuid primary key default gen_random_uuid(),
  branch text not null check (branch = 'main' or branch ~ '^pageagents/[0-9a-f-]{36}$'),
  -- A stable name the agents use, such as `file:apps/demo-app/src/shop/cart.ts`.
  key text not null check (key <> '' and char_length(key) <= 300),
  kind text not null check (kind ~ '^[a-z][a-z_]{0,30}$'),
  title text not null check (title <> '' and char_length(title) <= 300),
  body text not null default '' check (char_length(body) <= 20000),
  embedding real[],
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  unique (branch, key)
);

create table kg_edges (
  id uuid primary key default gen_random_uuid(),
  branch text not null check (branch = 'main' or branch ~ '^pageagents/[0-9a-f-]{36}$'),
  from_key text not null check (from_key <> ''),
  to_key text not null check (to_key <> ''),
  relation text not null check (relation ~ '^[a-z][a-z_]{0,30}$'),
  version integer not null default 1 check (version >= 1),
  updated_at timestamptz not null default now(),
  unique (branch, from_key, to_key, relation)
);

create index kg_edges_from on kg_edges (branch, from_key);
create index kg_edges_to on kg_edges (branch, to_key);

create table kg_versions (
  id bigserial primary key,
  entity text not null check (entity in ('node', 'edge')),
  entity_id uuid not null,
  branch text not null,
  version integer not null check (version >= 1),
  -- The entity as this version left it, without its embedding.
  snapshot jsonb not null,
  run_id uuid,
  author text not null check (author <> ''),
  created_at timestamptz not null default now(),
  commit_sha text check (commit_sha ~ '^[0-9a-f]{40}$'),
  pushed_at timestamptz,
  check ((commit_sha is null) = (pushed_at is null)),
  unique (entity, entity_id, version)
);

create index kg_versions_entity on kg_versions (entity, entity_id, version);
create index kg_versions_unpushed on kg_versions (branch) where commit_sha is null;

-- A commit, once recorded, is history: it can't be changed or taken back.
create function kg_versions_commit_once() returns trigger
language plpgsql as $$
begin
  if old.commit_sha is not null and new.commit_sha is distinct from old.commit_sha then
    raise exception 'kg_versions %: commit_sha is already %', old.id, old.commit_sha;
  end if;
  return new;
end;
$$;

create trigger kg_versions_commit_once
before update on kg_versions
for each row execute function kg_versions_commit_once();

-- What jev decided about an issue: its triage, the tier to start at, and each escalation.
create table decisions (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  run_id uuid,
  question text not null check (question in ('triage', 'start_tier', 'escalation')),
  model text not null check (model <> ''),
  choice text not null check (choice <> ''),
  probabilities jsonb not null,
  confidence real not null check (confidence >= 0 and confidence <= 1),
  cost_usd real not null default 0 check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index decisions_issue on decisions (issue_id, created_at);

-- The tier triage picked for the issue's first fix. Null starts at Tier 1.
alter table issues add column start_tier smallint check (start_tier between 1 and 3);
