import { Inject } from '@nestjs/common';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from '@nestjs/websockets';
import {
  NODE_NAMESPACE,
  nodeToServerEvents,
  type NodeToServerEvents,
  type ServerToNodeEvents,
  type Step,
} from '@page/contracts';
import type { Namespace } from 'socket.io';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { RunsService, type RunOwner } from '../runs/runs.service.ts';
import { CONFIG, LOGGER } from '../tokens.ts';
import { Nodes, type NodeSocket } from './nodes.ts';
import { RunKills } from './run-kills.ts';
import {
  guardHandshakes,
  limitMessages,
  listen,
  socketAddress,
  type SocketGuard,
} from './socket-guard.ts';
import { UiGateway } from './ui.gateway.ts';

type NodeNamespace = Namespace<NodeToServerEvents, ServerToNodeEvents>;
type NodeEvent = keyof NodeToServerEvents;
type NodePayload<E extends NodeEvent> = Parameters<NodeToServerEvents[E]>[0];
type Handler<E extends NodeEvent> = (
  socket: NodeSocket,
  payload: NodePayload<E>,
) => Promise<void> | void;

// A daemon connects once. While the orchestrator is down, socket.io-client retries at most
// every 5s, and those tries never reach the namespace; after a refusal the daemon waits a
// minute. 30 leaves room for several daemons behind one address, and holds a secret guesser
// to 30 tries a minute.
export const NODE_HANDSHAKES_PER_MINUTE = 30;
// A run sends a step per command, and each command waits on a model call, so a run sends
// well under one a second. A daemon that lost its connection sends the events it buffered
// all at once when it is back, so 300 leaves room for minutes of them. A socket past it is
// closed; its steps are in the `steps` table either way.
export const NODE_MESSAGES_PER_10_SECONDS = 300;

/** One daemon socket: its events, handled in the order it sent them, and its runs' owners. */
interface Link {
  queue: Promise<void>;
  // null for a run no issue knows. Looked up once per socket, on its first event for the run.
  owners: Map<string, RunOwner | null>;
}

const runIdOf = (payload: NodePayload<NodeEvent>) =>
  'step' in payload ? payload.step.runId : payload.runId;

/**
 * The Socket.IO namespace for node daemons. A handshake needs NODE_SHARED_SECRET as
 * `auth.token` and is refused with `unauthorized` without it.
 *
 * Each event a daemon sends is checked against its contract, and one that fails is logged and
 * dropped. A socket holds a run (Nodes) from its first event naming it, and if that run is no
 * longer its issue's run in progress, the daemon gets `run.kill`: the issue was killed while
 * no daemon held the run, or moved on. Steps, diffs and results go to the UI as `run.step`,
 * `run.diff` and `run.finished`, and a run's first step (seq 0) also sends `run.started`.
 * None of this is a record: the daemon writes each step to the `steps` table itself, and the
 * `run_finished` job is the run's record.
 */
@WebSocketGateway({ namespace: NODE_NAMESPACE, serveClient: false })
export class NodeGateway
  implements OnGatewayInit<NodeNamespace>, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly guard: SocketGuard;
  private readonly links = new Map<string, Link>();

  /**
   * What each event does once it passes its contract. An event with no handler is logged and
   * dropped, so a new one goes here: `node.approval.request` comes with Tier 3 approvals.
   */
  private readonly handlers: { [E in NodeEvent]?: Handler<E> } = {
    'node.step': (socket, { step }) => this.relayStep(socket, step),
    'node.diff': (_socket, diff) => this.ui.send('run.diff', diff),
    'node.run.finished': (socket, result) => this.relayFinished(socket, result),
  };

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly nodes: Nodes,
    private readonly runs: RunsService,
    private readonly kills: RunKills,
    private readonly ui: UiGateway,
  ) {
    this.guard = {
      name: 'node',
      secret: config.nodeSharedSecret,
      handshakes: new RateLimiter(NODE_HANDSHAKES_PER_MINUTE, 60_000),
      messages: new RateLimiter(NODE_MESSAGES_PER_10_SECONDS, 10_000),
      logger,
    };
  }

  afterInit(namespace: NodeNamespace): void {
    guardHandshakes(namespace, this.guard);
  }

  handleConnection(socket: NodeSocket): void {
    limitMessages(socket, this.guard);
    const address = socketAddress(socket);
    this.nodes.add(socket, address);
    this.links.set(socket.id, { queue: Promise.resolve(), owners: new Map() });
    listen(socket, nodeToServerEvents, this.guard, (event, payload) =>
      this.receive(socket, event, payload),
    );
    this.logger.info({ address }, 'node daemon connected');
  }

  handleDisconnect(socket: NodeSocket): void {
    const runIds = this.nodes.remove(socket);
    this.links.delete(socket.id);
    this.logger.warn({ address: socketAddress(socket), runIds }, 'node daemon disconnected');
  }

  private receive(socket: NodeSocket, event: NodeEvent, payload: NodePayload<NodeEvent>): void {
    const link = this.links.get(socket.id);
    if (!link) return;
    const runId = runIdOf(payload);
    // At once, not in the queue, so a kill that lands while earlier events wait finds it.
    const finished = event === 'node.run.finished';
    if (finished) this.nodes.release(runId, socket);
    else this.nodes.hold(runId, socket);

    const handler = this.handlers[event] as Handler<NodeEvent> | undefined;
    if (!handler) this.logger.warn({ event, runId }, 'no handler for this node event yet; dropped');
    link.queue = link.queue
      .then(async () => {
        if (!finished) await this.check(socket, runId);
        await handler?.(socket, payload);
      })
      .catch((err: unknown) => {
        this.logger.error({ err, event, runId }, 'node event failed');
      });
  }

  /**
   * On a socket's first event for a run, kills a run that is no longer its issue's run in
   * progress. Its fix job is cancelled already; this stops the daemon still on it.
   */
  private async check(socket: NodeSocket, runId: string): Promise<void> {
    const owners = this.links.get(socket.id)?.owners;
    if (!owners || owners.has(runId)) return;
    const owner = await this.ownerOf(socket, runId);
    if (owner?.current) return;
    this.logger.warn(
      { runId, issueId: owner?.issueId },
      'a daemon is on a run that is no longer in progress; killing it',
    );
    this.kills.stop(runId, owner?.issueId);
  }

  private async relayStep(socket: NodeSocket, step: Step): Promise<void> {
    if (step.seq === 0) {
      const owner = await this.ownerOf(socket, step.runId);
      // The moment GET /issues/:id/runs starts calling the run `running`.
      if (owner?.current) {
        this.ui.send('run.started', {
          v: 1,
          run: {
            id: step.runId,
            issueId: owner.issueId,
            tier: owner.tier,
            status: 'running',
            startedAt: step.createdAt,
            finishedAt: null,
            prUrl: null,
            confidence: null,
          },
        });
      }
    }
    this.ui.send('run.step', { v: 1, step });
  }

  private async relayFinished(
    socket: NodeSocket,
    result: NodePayload<'node.run.finished'>,
  ): Promise<void> {
    const { runId } = result;
    this.links.get(socket.id)?.owners.delete(runId);
    // Looked up again for the first step's time, which the run had no row for before.
    const owner = await this.runs.owner(runId);
    if (!owner) {
      this.logger.warn({ runId }, 'run finished for a run no issue knows; not relayed');
      return;
    }
    this.ui.send('run.finished', {
      v: 1,
      run: {
        id: runId,
        issueId: owner.issueId,
        tier: owner.tier,
        status: result.status,
        startedAt: owner.startedAt,
        // When the server heard; the run_finished job carries the daemon's own times.
        finishedAt: new Date().toISOString(),
        prUrl: result.prUrl,
        confidence: result.confidence,
      },
      note: result.note,
    });
  }

  /** The run's owner, looked up once per socket. A lookup that throws is tried again. */
  private async ownerOf(socket: NodeSocket, runId: string): Promise<RunOwner | undefined> {
    const owners = this.links.get(socket.id)?.owners;
    const known = owners?.get(runId);
    if (known !== undefined) return known ?? undefined;
    const owner = await this.runs.owner(runId);
    owners?.set(runId, owner ?? null);
    return owner;
  }
}
