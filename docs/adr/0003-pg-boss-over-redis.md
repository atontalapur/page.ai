# 0003. pg-boss over Redis

- Status: Accepted
- Date: 2026-11-09
- Card: #26

## Context

The orchestrator queues triage, fix and notify work. A fix job has to commit in the same
Postgres transaction as the issue update that causes it, and one fingerprint must not grow
two jobs for the same queue while one is still open. Redis would be a second datastore, and
the job would be published outside that transaction.

## Decision

Use pg-boss in the same Postgres database as the issue tables, in its own schema
(`PGBOSS_SCHEMA`).

1. **Three queues.** `triage` retries 3 times with exponential backoff. `fix` does not retry;
   a failure escalates. `notify` retries a call 3 times, and the last failure sends SMS.
2. **One job per fingerprint.** Each queue is created with the `exclusive` policy and every
   send sets `singletonKey` to the fingerprint, so a repeat report does not enqueue another
   job. Every tier shares the `fix` queue, so the key holds across an escalation. The run a
   new tier replaces is cancelled in the same transaction, which frees the key.
3. **Payloads are the contracts.** `jobSchemas` in `@page/contracts` is parsed before send and
   again when a worker receives the job.
4. **The fix job shares the status-change transaction** through pg-boss's `fromKysely`, so a
   rolled-back transition leaves no job.

## Consequences

- Queueing needs no extra service. `DATABASE_URL` is enough to boot.
- pg-boss owns its tables and migrates them inside `PGBOSS_SCHEMA` at startup.
- A second send for a fingerprint that already has an open job returns no id. The caller
  leaves the issue where it is.
