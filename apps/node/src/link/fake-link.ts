import type { Logger } from 'pino';
import {
  checked,
  received,
  type NodeEvent,
  type NodePayload,
  type OrchestratorLink,
  type ServerEvent,
  type ServerHandler,
} from './link.ts';

export type SentEvent = { [E in NodeEvent]: { event: E; payload: NodePayload<E> } }[NodeEvent];

/** Records each event after checking it against the contract; logs it if given a logger. */
export class FakeLink implements OrchestratorLink {
  readonly sent: SentEvent[] = [];
  closed = false;
  private readonly logger: Logger | undefined;
  private readonly handlers = new Map<ServerEvent, ((payload: unknown) => void)[]>();

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  send<E extends NodeEvent>(event: E, payload: NodePayload<E>): void {
    const sent = { event, payload: checked(event, payload) } as SentEvent;
    this.sent.push(sent);
    this.logger?.info({ event, payload: sent.payload }, 'event for the orchestrator');
  }

  /** The payloads sent as `event`, in order. */
  payloads<E extends NodeEvent>(event: E): NodePayload<E>[] {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload as NodePayload<E>);
  }

  on<E extends ServerEvent>(event: E, handler: ServerHandler<E>): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (payload: unknown) => void);
    this.handlers.set(event, list);
  }

  /** Plays the orchestrator sending `event`, through the same contract check as the socket. */
  deliver(event: ServerEvent, payload: unknown): void {
    const parsed = received(event, payload, this.logger);
    if (parsed === undefined) return;
    for (const handler of this.handlers.get(event) ?? []) handler(parsed);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
