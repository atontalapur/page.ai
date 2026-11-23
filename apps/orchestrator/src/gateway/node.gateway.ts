import { Inject } from '@nestjs/common';
import { WebSocketGateway, type OnGatewayConnection, type OnGatewayInit } from '@nestjs/websockets';
import { NODE_NAMESPACE, type NodeToServerEvents, type ServerToNodeEvents } from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { RateLimiter } from '../rate-limit.ts';
import { CONFIG, LOGGER } from '../tokens.ts';
import { guardHandshakes, limitMessages, socketAddress, type SocketGuard } from './socket-guard.ts';

type NodeNamespace = Namespace<NodeToServerEvents, ServerToNodeEvents>;
type NodeSocket = Socket<NodeToServerEvents, ServerToNodeEvents>;

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

/**
 * The Socket.IO namespace for node daemons. A handshake needs NODE_SHARED_SECRET as
 * `auth.token` and is refused with `unauthorized` without it.
 */
@WebSocketGateway({ namespace: NODE_NAMESPACE, serveClient: false })
export class NodeGateway implements OnGatewayInit<NodeNamespace>, OnGatewayConnection {
  private readonly guard: SocketGuard;

  constructor(
    @Inject(CONFIG) config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
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
    this.logger.info({ address: socketAddress(socket) }, 'node daemon connected');
  }
}
