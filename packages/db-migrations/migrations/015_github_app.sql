-- The GitHub App the dashboard creates for the agents (GitHubAppService), so PRs come from
-- `<slug>[bot]` rather than a person's token. One row at most. The private key and the
-- webhook secret are AES-256-GCM ciphertext under SECRETS_KEY, never plaintext; a database
-- dump alone can't act as the bot. installation_id and repo are set once the app is
-- installed on the demo repo.
create table github_app (
  id smallint primary key default 1 check (id = 1),
  app_id bigint not null,
  slug text not null check (slug <> ''),
  html_url text not null check (html_url <> ''),
  owner text not null check (owner <> ''),
  private_key_enc text not null check (private_key_enc <> ''),
  webhook_secret_enc text not null check (webhook_secret_enc <> ''),
  installation_id bigint,
  repo text check (repo ~ '^[\w.-]+/[\w.-]+$'),
  created_at timestamptz not null default now(),
  installed_at timestamptz,
  check ((installation_id is null) = (installed_at is null))
);
