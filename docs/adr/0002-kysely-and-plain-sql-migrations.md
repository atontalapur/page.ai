# 0002. Kysely over Postgres with plain SQL migrations

- Status: Accepted (in use since #49)
- Date: 2026-11-08
- Card: #25

## Context

The orchestrator keeps issues, runs, steps, escalations and approvals in Postgres. The
schema relies on Postgres features: a partial unique index for one open issue per
fingerprint, CHECK constraints that mirror the `@page/contracts` enums, and `jsonb`
columns. pg-boss queues fix jobs in the same database, and queueing a job has to commit
in the same transaction as the issue update that causes it.

The repo also constrains the choice. pnpm blocks dependency build scripts, packages have
no build step, and Node runs `.ts` source by stripping types, so there is no `tsx` or
esbuild. Unit tests run on PGlite, and the demo app already uses plain SQL migrations.

#18 left Prisma vs Drizzle open. #49 used Kysely and plain SQL instead, and this records
why.

## Decision

1. **Kysely as the query builder.** Table types are written by hand in
   `apps/orchestrator/src/db/database.ts`. Kysely needs no code generation and no schema
   DSL, and its PGlite dialect lets unit tests use the same queries against in-memory
   Postgres.
2. **Migrations are plain `.sql` files** in `packages/db-migrations/migrations/`, applied
   in file-name order. They use Postgres directly (partial indexes, CHECK constraints,
   `jsonb`) without going through an ORM's schema language.
3. **The orchestrator migrates at boot.** `migrate()` takes a transaction-scoped advisory
   lock, so concurrent boots serialise, and applies pending files in one transaction,
   recording each in `schema_migrations`. A failing file rolls back the whole run.
4. **pg-boss shares the Kysely transaction**, so a fix job is queued only if the issue
   update that caused it commits.

Prisma was ruled out because it generates its client from its own schema file, so every
checkout needs a generate step before typecheck, and the schema DSL sits between us and
the Postgres features above. Drizzle was ruled out because `drizzle-kit` depends on
`esbuild` and `tsx`, which the repo avoids.

## Consequences

- The SQL and the TypeScript table types are kept in step by hand. In
  `apps/orchestrator/src/db`, `schema.test.ts` checks each CHECK list against the contracts
  enums on PGlite, and `schema.int.test.ts` writes every table on real Postgres and parses
  each row with its contracts schema. A change to one without the other fails there.
- Migrations only go forward. To undo one, write a new file.
- `jsonb` columns are written as JSON strings, so node-postgres and PGlite serialise them
  the same way.
- The migrations and `loadMigrations()` live in `@page/db-migrations`, not in the
  orchestrator, so tests elsewhere that need the tables (toolkit's audit sink, the node
  daemon) apply the same files through the same loader instead of reading an app's files.
- The audit tables (`runs`, `escalations`, `approvals`) don't cascade on delete. An issue
  with runs, or a run with escalations or approvals, can't be deleted.
