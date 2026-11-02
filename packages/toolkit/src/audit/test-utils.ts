import { InMemoryAuditSink } from './memory-sink.ts';
import { StepLog } from './step-log.ts';

export const TEST_ISSUE_ID = '00000000-0000-4000-8000-000000000001';
export const TEST_RUN_ID = '00000000-0000-4000-8000-000000000002';

/** A StepLog over an in-memory sink, for tests that don't look at the audit trail. */
export function testSteps(sink = new InMemoryAuditSink()): StepLog {
  return new StepLog({ sink, issueId: TEST_ISSUE_ID, runId: TEST_RUN_ID });
}
