import { serverToUiEvents, type Issue } from '@page/contracts';

/**
 * Where a source stands. `needs_token` means the server refused the token, or there is none
 * yet; `mock` means no server is connected and the mock source is playing events.
 */
export type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'needs_token' | 'mock';

/** What a source tells the issues store. */
export interface IssueFeed {
  /** A full list: the first load, and again after each reconnect. Newer copies win. */
  reset(issues: Issue[]): void;
  /** One issue opened or changed. */
  update(issue: Issue): void;
  status(status: FeedStatus): void;
}

export interface IssueSource {
  /** Starts feeding, and returns the function that stops it. */
  start(feed: IssueFeed): () => void;
  /** One issue by id, for a detail page whose issue isn't in the list. */
  fetchIssue(id: string): Promise<Issue | undefined>;
}

/**
 * The issue in an `issue.updated` payload, or undefined when the payload breaks the
 * contract (a `v` this build doesn't know, a missing field). Both sources pass every event
 * through here, so the mock is held to the same contract as the server.
 */
export function parseIssueUpdated(payload: unknown): Issue | undefined {
  const parsed = serverToUiEvents['issue.updated'].safeParse(payload);
  if (parsed.success) return parsed.data.issue;
  console.warn('dropped an issue.updated that breaks the contract', parsed.error.issues);
  return undefined;
}
