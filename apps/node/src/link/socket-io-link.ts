import { NODE_NAMESPACE, type NodeToServerEvents, type ServerToNodeEvents } from '@page/contracts';
import type { Logger } from 'pino';
import { io, type Socket } from 'socket.io-client';
import {
  checked,
  received,
  type NodeEvent,
  type NodePayload,
  type OrchestratorLink,
  type ServerEvent,
  type ServerHandler,
} from './link.ts';

// A refusal (`unauthorized`, `rate_limited`, or a server without the namespace) won't clear
// sooner: the handshake limit counts a minute, and a secret changes with a deploy.
const RETRY_REFUSED_MS = 60_000;
// After the orchestrator closed the socket, as socket.io-client's longest reconnect delay.
const RETRY_CLOSED_MS = 5_000;

export interface SocketIoLinkOptions {
  /** The orchestrator's base URL, e.g. https://orchestrator.example.com. */
  url: string;
  /** NODE_SHARED_SECRET. Sent as `auth.token` in the handshake. */
  secret: string;
  logger: Logger;
  /** Milliseconds before trying again after a refusal, and after the server closed the socket. */
  retry?: { refusedMs: number; closedMs: number };
}

/**
 * Connects out to the orchestrator over Socket.IO, so the daemon needs no open port.
 * socket.io-client reconnects on its own after a dropped connection, a restart of the
 * orchestrator included, and buffers events sent while disconnected. It gives up on a
 * handshake the orchestrator refused and on a socket the orchestrator closed, so the link
 * connects again itself after those.
 */
export class SocketIoLink implements OrchestratorLink {
  private readonly socket: Socket<ServerToNodeEvents, NodeToServerEvents>;
  private readonly logger: Logger;
  private readonly retry: { refusedMs: number; closedMs: number };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor({ url, secret, logger, retry }: SocketIoLinkOptions) {
    this.logger = logger;
    this.retry = retry ?? { refusedMs: RETRY_REFUSED_MS, closedMs: RETRY_CLOSED_MS };
    this.socket = io(new URL(NODE_NAMESPACE, url).href, {
      auth: { token: secret },
      transports: ['websocket'],
    });
    this.socket.on('connect', () => logger.info({ url }, 'connected to the orchestrator'));
    this.socket.on('disconnect', (reason) => {
      logger.warn({ url, reason }, 'disconnected from the orchestrator');
      // `io server disconnect`: the orchestrator closed it, say for too many messages.
      if (!this.socket.active) this.connectLater(this.retry.closedMs);
    });
    this.socket.on('connect_error', (error) => {
      if (this.socket.active) {
        logger.warn({ url, err: error.message }, 'cannot reach the orchestrator; retrying');
        return;
      }
      logger.error(
        { url, err: error.message, retryInMs: this.retry.refusedMs },
        'the orchestrator refused the socket; trying again later',
      );
      this.connectLater(this.retry.refusedMs);
    });
  }

  private connectLater(ms: number): void {
    if (this.closed || this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.closed) this.socket.connect();
    }, ms);
  }

  send<E extends NodeEvent>(event: E, payload: NodePayload<E>): void {
    // The typed emit wants the event as a literal; the payload is already checked.
    const emit = this.socket.emit.bind(this.socket) as (e: string, p: unknown) => void;
    emit(event, checked(event, payload));
  }

  on<E extends ServerEvent>(event: E, handler: ServerHandler<E>): void {
    // The typed on() wants a literal too, and the payload is unchecked until parsed here.
    const listen = this.socket.on.bind(this.socket) as (
      e: string,
      listener: (payload: unknown) => void,
    ) => void;
    listen(event, (payload) => {
      const parsed = received(event, payload, this.logger);
      if (parsed !== undefined) handler(parsed);
    });
  }

  close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.socket.close();
    return Promise.resolve();
  }
}
