-- Shop settings set through the ops API (#13). A row overrides the env variable of the
-- same name; the app reads the table once per process, so a change applies on restart.
-- Keys are checked in code (src/config.ts), so a new setting needs no migration.
create table runtime_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
