-- issue_events gets the CHECK lists issues already has, so a row the contracts reject on
-- read (issueEventRecordSchema) can't be written. The lists copy ISSUE_STATUSES from
-- packages/contracts/src/db.ts; apps/orchestrator/src/db/schema.test.ts fails when they
-- drift apart.
--
-- The event log is the audit record, like runs, so its issue foreign key restricts instead
-- of cascading: an issue with history can't be deleted, and its log can't be lost.

alter table issue_events
  add constraint issue_events_from_status_check check (
    from_status in ('new', 'triaged', 'fixing', 'pr_open', 'awaiting_approval', 'resolved', 'failed', 'killed')
  ),
  add constraint issue_events_to_status_check check (
    to_status in ('new', 'triaged', 'fixing', 'pr_open', 'awaiting_approval', 'resolved', 'failed', 'killed')
  ),
  add constraint issue_events_current_tier_check check (current_tier between 1 and 3),
  drop constraint issue_events_issue_id_fkey,
  add constraint issue_events_issue_id_fkey
    foreign key (issue_id) references issues (id) on delete restrict;
