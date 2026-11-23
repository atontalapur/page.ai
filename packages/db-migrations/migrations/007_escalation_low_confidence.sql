-- A submitted run that scores below its tier's confidence threshold escalates with
-- `low_confidence` (packages/agent/src/threshold.ts). The list copies ESCALATION_REASONS from
-- packages/contracts/src/db.ts; apps/orchestrator/src/db/schema.test.ts fails when they drift
-- apart. Existing rows all hold one of the old reasons, so the new check passes on them.

alter table escalations
  drop constraint escalations_reason_check,
  add constraint escalations_reason_check check (
    reason in ('needs_higher_tier', 'tests_failing', 'budget_exhausted', 'agent_error', 'low_confidence')
  );
