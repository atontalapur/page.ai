import { nodeToServerEvents, type NodeToServerEvents } from '@page/contracts';

export type NodeEvent = keyof NodeToServerEvents;
export type NodePayload<E extends NodeEvent> = Parameters<NodeToServerEvents[E]>[0];

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
  close(): Promise<void>;
}

/**
 * Parses an outgoing payload against its contract, so the daemon never sends what the
 * server would reject. Throws: a bad payload here is a daemon bug.
 */
export function checked<E extends NodeEvent>(event: E, payload: NodePayload<E>): NodePayload<E> {
  return nodeToServerEvents[event].parse(payload) as NodePayload<E>;
}
