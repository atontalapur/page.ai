import type { NodeToServerEvents, ServerToNodeEvents } from '@page/contracts';
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

/** The Socket.IO namespace the orchestrator serves node daemons on. */
export const NODE_NAMESPACE = '/node';

export interface SocketIoLinkOptions {
  /** The orchestrator's base URL, e.g. https://orchestrator.example.com. */
  url: string;
  /** NODE_SHARED_SECRET. Sent as `auth.token` in the handshake. */
  secret: string;
  logger: Logger;
}

/**
 * Connects out to the orchestrator over Socket.IO, so the daemon needs no open port.
 * socket.io-client reconnects on its own and buffers events sent while disconnected.
 */
export class SocketIoLink implements OrchestratorLink {
  private readonly socket: Socket<ServerToNodeEvents, NodeToServerEvents>;
  private readonly logger: Logger;

  constructor({ url, secret, logger }: SocketIoLinkOptions) {
    this.logger = logger;
    this.socket = io(new URL(NODE_NAMESPACE, url).href, {
      auth: { token: secret },
      transports: ['websocket'],
    });
    this.socket.on('connect', () => logger.info({ url }, 'connected to the orchestrator'));
    this.socket.on('disconnect', (reason) =>
      logger.warn({ url, reason }, 'disconnected from the orchestrator'),
    );
    this.socket.on('connect_error', (error) =>
      logger.warn({ url, err: error.message }, 'cannot reach the orchestrator; retrying'),
    );
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
    this.socket.close();
    return Promise.resolve();
  }
}
