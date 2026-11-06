import type { Logger } from 'pino';
import { checked, type NodeEvent, type NodePayload, type OrchestratorLink } from './link.ts';

export type SentEvent = { [E in NodeEvent]: { event: E; payload: NodePayload<E> } }[NodeEvent];

/** Records each event after checking it against the contract; logs it if given a logger. */
export class FakeLink implements OrchestratorLink {
  readonly sent: SentEvent[] = [];
  closed = false;
  private readonly logger: Logger | undefined;

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

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}
