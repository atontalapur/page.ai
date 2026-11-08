import {
  nodeToServerEvents,
  serverToNodeEvents,
  type NodeToServerEvents,
  type ServerToNodeEvents,
} from '@page/contracts';
import type { Logger } from 'pino';

export type NodeEvent = keyof NodeToServerEvents;
export type NodePayload<E extends NodeEvent> = Parameters<NodeToServerEvents[E]>[0];

export type ServerEvent = keyof ServerToNodeEvents;
export type ServerPayload<E extends ServerEvent> = Parameters<ServerToNodeEvents[E]>[0];
export type ServerHandler<E extends ServerEvent> = (payload: ServerPayload<E>) => void;

/**
 * The daemon's outbound line to the orchestrator, for the `nodeToServerEvents` in
 * contracts. SocketIoLink is the real one; FakeLink records events for tests and
 * USE_FAKE_ADAPTERS.
 *
 * `send` doesn't wait: the steps table is the record and a live event is best effort. A
 * link that is down buffers and sends on reconnect.
 */
export interface OrchestratorLink {
  send<E extends NodeEvent>(event: E, payload: NodePayload<E>): void;
  /**
   * Calls `handler` for each `event` the orchestrator sends that matches its contract.
   * One that doesn't is logged and dropped.
   */
  on<E extends ServerEvent>(event: E, handler: ServerHandler<E>): void;
  close(): Promise<void>;
}

/**
 * Parses an outgoing payload against its contract, so the daemon never sends what the
 * server would reject. Throws: a bad payload here is a daemon bug.
 */
export function checked<E extends NodeEvent>(event: E, payload: NodePayload<E>): NodePayload<E> {
  return nodeToServerEvents[event].parse(payload) as NodePayload<E>;
}

/**
 * Parses an incoming payload against its contract. Unlike `checked`, a bad payload is the
 * sender's problem, so it is logged and dropped instead of thrown.
 */
export function received<E extends ServerEvent>(
  event: E,
  payload: unknown,
  logger: Logger | undefined,
): ServerPayload<E> | undefined {
  const parsed = serverToNodeEvents[event].safeParse(payload);
  if (parsed.success) return parsed.data as ServerPayload<E>;
  logger?.warn({ event, err: parsed.error.message }, 'dropped an event that breaks its contract');
  return undefined;
}
