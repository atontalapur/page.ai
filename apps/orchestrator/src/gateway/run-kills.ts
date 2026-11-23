import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { IssueUpdates } from '../issues/issue-updates.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { TransitionError } from '../issues/transitions.ts';
import type { Logger } from '../logger.ts';
import { RunsService } from '../runs/runs.service.ts';
import { LOGGER } from '../tokens.ts';
import { Nodes } from './nodes.ts';

/**
 * Stops runs at the daemon that holds them. Every committed change that cancels a run's fix
 * job sends that daemon `run.kill`; it stops the run and reports it `killed`. That covers a
 * kill from POST /issues/:id/events and from the UI's socket, and a run the orchestrator
 * failed without a result. A run no daemon holds right now is still cancelled in pg-boss, and
 * NodeGateway kills it when its daemon next names it.
 */
@Injectable()
export class RunKills implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly issues: IssuesService,
    private readonly runs: RunsService,
    private readonly nodes: Nodes,
    private readonly updates: IssueUpdates,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.updates.subscribe((issue, { cancelledRunId }) => {
      if (cancelledRunId !== undefined) this.stop(cancelledRunId, issue.id);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /**
   * The UI's `run.kill`. A run in progress kills its issue, as the issue `kill` event does,
   * and the cancelled job reaches the daemon through the listener above. Any other run is
   * only stopped at a daemon still holding it.
   */
  async kill(runId: string): Promise<void> {
    const owner = await this.runs.owner(runId);
    if (owner?.current) {
      try {
        await this.issues.apply(owner.issueId, { type: 'kill' });
        return;
      } catch (err) {
        // The run finished, or the issue was killed, since the lookup.
        if (!(err instanceof TransitionError)) throw err;
      }
    }
    if (!this.stop(runId, owner?.issueId)) {
      this.logger.info({ runId, issueId: owner?.issueId }, 'kill for a run no daemon holds');
    }
  }

  /** Sends `run.kill` to the daemon holding `runId`. False when none does. */
  stop(runId: string, issueId?: string): boolean {
    const sent = this.nodes.send(runId, 'run.kill', { v: 1, runId });
    if (sent) this.logger.info({ runId, issueId }, 'sent run.kill to the daemon holding the run');
    return sent;
  }
}
