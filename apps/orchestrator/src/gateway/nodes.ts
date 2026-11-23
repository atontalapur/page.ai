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
  /** The name it sent in its handshake (contracts nodeNameSchema). */
  name: string;
  address: string;
  connectedAt: string;
  runIds: string[];
}

/** A daemon by name, as this instance sees it. */
export interface NodeState {
  connected: boolean;
  /** Since it connected, or since it left; null when this instance never saw it. */
  since: string | null;
  /** The runs its sockets hold, oldest first. */
  runIds: string[];
}

interface Entry {
  socket: NodeSocket;
  name: string;
  address: string;
  connectedAt: Date;
  runs: Set<string>;
}

// Daemons that left are remembered by name, for "offline since", up to this many.
const MAX_DEPARTED = 100;

/**
 * The daemons connected to this instance, and which one holds each run. A daemon claims a run
 * from the pg-boss `fix` queue, which doesn't record which daemon took it, so the claim is
 * pg-boss's and this only routes: a socket holds a run from its first event that names it
 * until its `node.run.finished`, or until it disconnects. It lives in memory, so after a
 * restart a daemon holds its runs again from its next event.
 *
 * The agents page knows a daemon by its name, which survives a reconnect where the socket id
 * doesn't. Sockets that share a name count as one daemon.
 */
@Injectable()
export class Nodes {
  private readonly sockets = new Map<string, Entry>();
  // runId to the id of the socket that holds it.
  private readonly holders = new Map<string, string>();
  // The name of a daemon with no socket left, and when its last one closed.
  private readonly departed = new Map<string, Date>();

  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  add(socket: NodeSocket, address: string, name: string): void {
    this.departed.delete(name);
    this.sockets.set(socket.id, {
      socket,
      name,
      address,
      connectedAt: new Date(),
      runs: new Set(),
    });
  }

  /** Forgets the socket and the runs it held. Returns its name and those runs. */
  remove(socket: NodeSocket): { name: string; runIds: string[] } | undefined {
    const entry = this.sockets.get(socket.id);
    if (!entry) return undefined;
    this.sockets.delete(socket.id);
    const runIds = [...entry.runs];
    for (const runId of runIds) this.holders.delete(runId);
    if (this.entries(entry.name).length === 0) {
      this.departed.set(entry.name, new Date());
      // The oldest departure first: a Map keeps insertion order.
      for (const name of this.departed.keys()) {
        if (this.departed.size <= MAX_DEPARTED) break;
        this.departed.delete(name);
      }
    }
    return { name: entry.name, runIds };
  }

  /**
   * Records that `socket` holds `runId`. A run moves to the socket that names it last.
   * Returns the names of the daemons whose runs changed: none when the socket held it already.
   */
  hold(runId: string, socket: NodeSocket): string[] {
    const entry = this.sockets.get(socket.id);
    if (!entry) return [];
    const previous = this.holders.get(runId);
    if (previous === socket.id) return [];
    const changed = new Set([entry.name]);
    if (previous !== undefined) {
      const other = this.sockets.get(previous);
      other?.runs.delete(runId);
      if (other) changed.add(other.name);
    }
    this.holders.set(runId, socket.id);
    entry.runs.add(runId);
    return [...changed];
  }

  /**
   * Forgets that `socket` holds `runId`. Another socket's hold on it is left alone. Returns
   * the name of the daemon that let it go, or none.
   */
  release(runId: string, socket: NodeSocket): string[] {
    if (this.holders.get(runId) !== socket.id) return [];
    this.holders.delete(runId);
    const entry = this.sockets.get(socket.id);
    entry?.runs.delete(runId);
    return entry ? [entry.name] : [];
  }

  holder(runId: string): NodeSocket | undefined {
    const id = this.holders.get(runId);
    return id === undefined ? undefined : this.sockets.get(id)?.socket;
  }

  /** The name `socket` connected with. */
  nameOf(socket: NodeSocket): string | undefined {
    return this.sockets.get(socket.id)?.name;
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

  /** Every connected daemon socket, oldest first. */
  list(): NodeInfo[] {
    return [...this.sockets.values()].map(({ socket, name, address, connectedAt, runs }) => ({
      id: socket.id,
      name,
      address,
      connectedAt: connectedAt.toISOString(),
      runIds: [...runs],
    }));
  }

  /** The names of the daemons connected now, and of those this instance saw leave. */
  names(): string[] {
    const connected = [...this.sockets.values()].map((entry) => entry.name);
    return [...new Set([...connected, ...this.departed.keys()])];
  }

  /** The daemon called `name`: its sockets taken together, or when it left. */
  state(name: string): NodeState {
    const entries = this.entries(name);
    if (entries.length === 0) {
      return {
        connected: false,
        since: this.departed.get(name)?.toISOString() ?? null,
        runIds: [],
      };
    }
    const since = Math.min(...entries.map((entry) => entry.connectedAt.getTime()));
    return {
      connected: true,
      since: new Date(since).toISOString(),
      runIds: entries.flatMap((entry) => [...entry.runs]),
    };
  }

  private entries(name: string): Entry[] {
    return [...this.sockets.values()].filter((entry) => entry.name === name);
  }
}
