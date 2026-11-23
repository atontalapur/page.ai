import { Inject, Injectable } from '@nestjs/common';
import type { Issue } from '@page/contracts';
import type { Logger } from '../logger.ts';
import { LOGGER } from '../tokens.ts';

/** What else a committed change did, beyond the issue it left. */
export interface IssueChange {
  /** The run whose fix job the change cancelled, so a daemon still on it should stop it. */
  cancelledRunId?: string;
}

export type IssueListener = (issue: Issue, change: IssueChange) => void;

/**
 * Each issue as a change to it commits. IssuesService publishes here and the gateways
 * listen, so neither side knows about the other. A listener that throws is logged and
 * skipped: the change is already committed, so its caller must not see the error.
 */
@Injectable()
export class IssueUpdates {
  private readonly listeners = new Set<IssueListener>();

  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  /** Adds `listener`, and returns the function that removes it. */
  subscribe(listener: IssueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(issue: Issue, change: IssueChange = {}): void {
    for (const listener of this.listeners) {
      try {
        listener(issue, change);
      } catch (err) {
        this.logger.error({ err, issueId: issue.id }, 'issue update listener failed');
      }
    }
  }
}
