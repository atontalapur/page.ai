-- Who applied each issue event: a person as `ui:<name>`, the shared API token as `api:shared`,
-- or the server as `system:triage` or `system:run` (ISSUE_EVENT_ACTORS in
-- packages/contracts/src/issue.ts). Events from before this have none, so the column is
-- nullable and old rows stay null.
alter table issue_events add column actor text;
