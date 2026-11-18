-- The sanitized error report ingest builds from the PostHog webhook (#136): request line,
-- exception and in-app frames, never bodies, headers or user fields. Every fix job carries
-- it. Null for an issue opened before this column, or through POST /issues; the fix job
-- then carries the title.
alter table issues add column report text check (report <> '');
