import { Inject, Injectable } from '@nestjs/common';
import {
  serverToNodeEvents,
  type NodeToServerEvents,
  type ServerToNodeEvents,
} from '@page/contracts';
import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { Logger } from '../logger.ts';
import { LOGGER } from '../tokens.ts';

export type NodeSocket = Socket<NodeToServerEvents, ServerToNodeEvents>;

type NodeEvent = keyof ServerToNodeEvents;
type NodePayload<E extends NodeEvent> = Parameters<ServerToNodeEvents[E]>[0];

/** A connected daemon and the runs it holds. */
export interface NodeInfo {
  /** The socket's id; a reconnect gets a new one. */
  id: string;
  address: string;
  connectedAt: string;
  runIds: string[];
}

interface Entry {
  socket: NodeSocket;
  address: string;
  connectedAt: Date;
  runs: Set<string>;
}

/**
 * The daemons connected to this instance, and which one holds each run. A daemon claims a run
 * from the pg-boss `fix` queue, which doesn't record which daemon took it, so the claim is
 * pg-boss's and this only routes: a socket holds a run from its first event that names it
 * until its `node.run.finished`, or until it disconnects. It lives in memory, so after a
 * restart a daemon holds its runs again from its next event.
 */
@Injectable()
export class Nodes {
  private readonly sockets = new Map<string, Entry>();
  // runId to the id of the socket that holds it.
  private readonly holders = new Map<string, string>();

  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  add(socket: NodeSocket, address: string): void {
    this.sockets.set(socket.id, { socket, address, connectedAt: new Date(), runs: new Set() });
  }

  /** Forgets the socket and the runs it held, and returns those runs. */
  remove(socket: NodeSocket): string[] {
    const entry = this.sockets.get(socket.id);
    this.sockets.delete(socket.id);
    const runs = [...(entry?.runs ?? [])];
    for (const runId of runs) this.holders.delete(runId);
    return runs;
  }

  /** Records that `socket` holds `runId`. A run moves to the socket that names it last. */
  hold(runId: string, socket: NodeSocket): void {
    const entry = this.sockets.get(socket.id);
    if (!entry) return;
    const previous = this.holders.get(runId);
    if (previous !== undefined && previous !== socket.id) {
      this.sockets.get(previous)?.runs.delete(runId);
    }
    this.holders.set(runId, socket.id);
    entry.runs.add(runId);
  }

  /** Forgets that `socket` holds `runId`. Another socket's hold on it is left alone. */
  release(runId: string, socket: NodeSocket): void {
    if (this.holders.get(runId) !== socket.id) return;
    this.holders.delete(runId);
    this.sockets.get(socket.id)?.runs.delete(runId);
  }

  holder(runId: string): NodeSocket | undefined {
    const id = this.holders.get(runId);
    return id === undefined ? undefined : this.sockets.get(id)?.socket;
  }

  /**
   * Sends `event` to the daemon holding `runId`, checked against its contract. Returns false
   * when no connected daemon holds the run, or the payload fails its contract.
   */
  send<E extends NodeEvent>(runId: string, event: E, payload: NodePayload<E>): boolean {
    const socket = this.holder(runId);
    if (!socket) return false;
    const parsed = serverToNodeEvents[event].safeParse(payload);
    if (!parsed.success) {
      this.logger.error(
        { runId, event, problems: z.prettifyError(parsed.error) },
        'node event failed its contract; not sent',
      );
      return false;
    }
    // The typed emit wants the event as a literal; the payload is already checked.
    const emit = socket.emit.bind(socket) as (e: string, p: unknown) => boolean;
    emit(event, parsed.data);
    return true;
  }

  /** Every connected daemon, oldest first, for the agents page. */
  list(): NodeInfo[] {
    return [...this.sockets.values()].map(({ socket, address, connectedAt, runs }) => ({
      id: socket.id,
      address,
      connectedAt: connectedAt.toISOString(),
      runIds: [...runs],
    }));
  }
}
