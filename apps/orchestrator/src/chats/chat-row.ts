import type { RunChat } from '@page/contracts';
import type { Selectable } from 'kysely';
import type { RunChatsTable } from '../db/database.ts';

/** A `run_chats` row as the contracts describe it. The table's CHECKs keep each status whole. */
export function toChat(row: Selectable<RunChatsTable>): RunChat {
  const base = {
    id: row.id,
    runId: row.run_id,
    issueId: row.issue_id,
    askedBy: row.asked_by,
    message: row.message,
    askedAt: row.asked_at.toISOString(),
  };
  if (row.status === 'pending') {
    return { ...base, status: 'pending', answer: null, reason: null, closedAt: null };
  }
  const closedAt = row.closed_at!.toISOString();
  if (row.status === 'answered') {
    return { ...base, status: 'answered', answer: row.answer!, reason: null, closedAt };
  }
  return { ...base, status: 'unanswered', answer: null, reason: row.reason!, closedAt };
}
