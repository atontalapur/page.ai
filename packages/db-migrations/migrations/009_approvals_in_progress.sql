-- Tier 3 approvals. A daemon asks for one while its run is in progress, and a run has no runs
-- row until its result is recorded (#136), so approvals.run_id can't reference runs. Like
-- steps.run_id, it becomes the fix job's id with no foreign key. Each request names its issue
-- instead, which keeps the audit record: an issue with approvals can't be deleted.
--
-- expires_at is when the daemon stops waiting. The server refuses a decision after it and
-- rejects the request as timed out. Rows from before this have their run's issue, and expire
-- at once, so a pending one left over is closed at boot.
alter table approvals drop constraint approvals_run_id_fkey;
alter table approvals add column issue_id uuid references issues (id) on delete restrict;
alter table approvals add column expires_at timestamptz;
update approvals
   set issue_id = runs.issue_id,
       expires_at = approvals.requested_at
  from runs
 where runs.id = approvals.run_id;
alter table approvals alter column issue_id set not null;
alter table approvals alter column expires_at set not null;

create index approvals_issue_id on approvals (issue_id, requested_at);
