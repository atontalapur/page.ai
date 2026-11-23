import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { nodeNameSchema, type NodeRun, type NodeSummary } from '@page/contracts';
import { z } from 'zod';
import { RateLimitGuard } from '../rate-limit.guard.ts';
import { NodeRuns } from '../runs/node-runs.ts';
import { NodeSummaries } from './node-summaries.ts';

// The agents page loads these when a tab connects or reconnects, and an agent's runs again
// when the daemon takes or lets go of one, so a tab asks a few times a minute at most. 60 a
// minute leaves room for several tabs behind one address.
export const NODE_REQUESTS_PER_MINUTE = 60;

export const DEFAULT_NODE_RUNS = 20;
export const MAX_NODE_RUNS = 100;

/** The node daemons and the runs they worked, for the UI's agents pages. */
@Controller('nodes')
@UseGuards(new RateLimitGuard(NODE_REQUESTS_PER_MINUTE, 60_000))
export class NodesController {
  constructor(
    private readonly summaries: NodeSummaries,
    private readonly runs: NodeRuns,
  ) {}

  /** Every daemon, connected or not, with the runs it holds, by name. */
  @Get()
  list(): Promise<NodeSummary[]> {
    return this.summaries.all();
  }

  /** The runs the daemon worked, the one it took last first. Empty for a name none worked. */
  @Get(':name/runs')
  runsOf(
    @Param('name', { schema: nodeNameSchema }) name: string,
    @Query('limit', {
      schema: z.coerce.number().int().min(1).max(MAX_NODE_RUNS).default(DEFAULT_NODE_RUNS),
    })
    limit: number,
  ): Promise<NodeRun[]> {
    return this.runs.forNode(name, limit);
  }
}
