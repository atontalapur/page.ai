import { issueDecisionSchema, type IssueDecision } from '@page/contracts';

import { readToken } from './token';

/** What jev decided about an issue, oldest first. */
export async function loadDecisions(issueId: string): Promise<IssueDecision[]> {
  const res = await fetch(`/issues/${issueId}/decisions`, {
    headers: { authorization: `Bearer ${readToken() ?? ''}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`The orchestrator answered ${res.status}.`);
  return ((await res.json()) as unknown[]).map((d) => issueDecisionSchema.parse(d));
}
