-- Why the agent asks for a gated call: the THOUGHT of the step that wanted it, as
-- approvalReason() in @page/contracts leaves it, capped at MAX_APPROVAL_REASON_CHARS (1,000).
-- It is the model's text, so the UI shows it as plain text. Null when the model gave none,
-- and for every request from before this column.
alter table approvals
  add column reason text check (reason <> '' and char_length(reason) <= 1000);
