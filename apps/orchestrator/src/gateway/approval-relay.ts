import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Approval } from '@page/contracts';
import { ApprovalsService } from '../approvals/approvals.service.ts';
import type { ApprovalsService as Approvals } from '../approvals/approvals.service.ts';
import type { Logger } from '../logger.ts';
import { LOGGER } from '../tokens.ts';
import { Nodes } from './nodes.ts';
import type { Nodes as NodeSockets } from './nodes.ts';
import { UiGateway } from './ui.gateway.ts';
import type { UiGateway as Tabs } from './ui.gateway.ts';

/**
 * Sends each approval change out: a new request to every tab as `approval.requested`, and a
 * decision to every tab as `approval.updated`, so none keeps showing it, and to the daemon
 * holding the run as `approval.decided`. A daemon that isn't connected gets its answer when
 * it sends the request again after it reconnects.
 */
@Injectable()
export class ApprovalRelay implements OnModuleInit, OnModuleDestroy {
  private unsubscribe: (() => void) | undefined;

  // Type-only aliases for the class-typed parameters, as in ApprovalsService.
  constructor(
    @Inject(ApprovalsService) private readonly approvals: Approvals,
    @Inject(UiGateway) private readonly ui: Tabs,
    @Inject(Nodes) private readonly nodes: NodeSockets,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.approvals.subscribe((approval) => this.relay(approval));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private relay(approval: Approval): void {
    if (approval.decision === 'pending') {
      this.ui.send('approval.requested', { v: 1, approval });
      return;
    }
    this.ui.send('approval.updated', { v: 1, approval });
    if (!this.nodes.send(approval.runId, 'approval.decided', { v: 1, approval })) {
      this.logger.info(
        { approvalId: approval.id, runId: approval.runId },
        'no daemon holds the run; it gets the decision when it asks again',
      );
    }
  }
}
