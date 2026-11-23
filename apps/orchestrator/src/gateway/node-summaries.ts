import { Injectable } from '@nestjs/common';
import type { NodeRun, NodeSummary } from '@page/contracts';
import { NodeRuns } from '../runs/node-runs.ts';
import { Nodes } from './nodes.ts';

/** How many daemons GET /nodes lists from past runs, beyond the ones this instance has seen. */
export const KNOWN_NODES = 50;

/**
 * Daemons as the agents page shows them: what this instance knows of their sockets (Nodes)
 * and what the database knows of the runs they worked (NodeRuns). GET /nodes and the
 * `node.updated` event both come from here, so a tab can replace its copy with either.
 */
@Injectable()
export class NodeSummaries {
  constructor(
    private readonly nodes: Nodes,
    private readonly runs: NodeRuns,
  ) {}

  /**
   * Every daemon connected here, every one this instance saw leave, and the ones that worked
   * the newest runs, by name.
   */
  async all(): Promise<NodeSummary[]> {
    const names = new Set([...this.nodes.names(), ...(await this.runs.recentNames(KNOWN_NODES))]);
    return this.summarize([...names].sort());
  }

  /** The daemon called `name`, or undefined when neither this instance nor a run knows it. */
  async one(name: string): Promise<NodeSummary | undefined> {
    const [node] = await this.summarize([name]);
    return node && (node.since !== null || node.lastRunAt !== null) ? node : undefined;
  }

  private async summarize(names: string[]): Promise<NodeSummary[]> {
    const states = names.map((name) => ({ name, ...this.nodes.state(name) }));
    const [lastRunAt, described] = await Promise.all([
      this.runs.lastRunAt(names),
      this.runs.describe(states.flatMap((state) => state.runIds)),
    ]);
    const runs = new Map<string, NodeRun>(described.map((run) => [run.id, run]));
    return states.map(({ name, connected, since, runIds }) => ({
      name,
      connected,
      since,
      current: runIds.flatMap((id) => runs.get(id) ?? []),
      lastRunAt: lastRunAt.get(name) ?? null,
    }));
  }
}
