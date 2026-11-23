import type { SocketRefusal } from '@page/contracts';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import { tokenAuthorized } from '../auth/bearer.ts';
import type { Logger } from '../logger.ts';
import { clientAddress, type RateLimiter } from '../rate-limit.ts';

/** How a namespace admits sockets and bounds what each one sends. */
export interface SocketGuard {
  /** `ui` or `node`, for the log lines. */
  name: string;
  /** The secret a handshake must carry as `auth.token`. Unset refuses every handshake. */
  secret: string | undefined;
  /** Handshakes per address. */
  handshakes: RateLimiter;
  /** Messages per socket. */
  messages: RateLimiter;
  logger: Logger;
}

/** The address a socket's handshake came from: the last `X-Forwarded-For` entry, or its own. */
export function socketAddress(socket: Socket): string {
  return clientAddress(socket.handshake.address, socket.handshake.headers['x-forwarded-for']);
}

/**
 * Refuses a handshake past its address's limit with `rate_limited`, then one without the
 * secret with `unauthorized`. The limit runs first, so guessing the secret stays bounded.
 * Middleware runs before the socket joins, so a refused one never receives an event.
 */
export function guardHandshakes(namespace: Namespace, guard: SocketGuard): void {
  namespace.use((socket, next) => {
    const refusal = refusalOf(socket, guard);
    if (refusal) return next(new Error(refusal satisfies SocketRefusal));
    next();
  });
}

function refusalOf(socket: Socket, guard: SocketGuard): SocketRefusal | undefined {
  const address = socketAddress(socket);
  if (!guard.handshakes.hit(address).allowed) {
    guard.logger.warn({ address }, `${guard.name} socket handshake rate limited`);
    return 'rate_limited';
  }
  const { token } = socket.handshake.auth as { token?: unknown };
  if (!tokenAuthorized(token, guard.secret)) return 'unauthorized';
  return undefined;
}

/**
 * Listens on `socket` for every event in `contracts`, and passes `handle` each payload that
 * passes its contract. One that fails is logged and dropped.
 */
export function listen<T extends Record<string, z.ZodType>>(
  socket: Socket,
  contracts: T,
  guard: SocketGuard,
  handle: (event: keyof T & string, payload: z.infer<T[keyof T]>) => void,
): void {
  // The typed on() wants a literal; the payload is unchecked until it is parsed here.
  const on = socket.on.bind(socket) as (event: string, fn: (raw: unknown) => void) => void;
  for (const event of Object.keys(contracts) as (keyof T & string)[]) {
    on(event, (raw) => {
      const parsed = contracts[event]!.safeParse(raw);
      if (parsed.success) return handle(event, parsed.data as z.infer<T[keyof T]>);
      guard.logger.warn(
        { event, address: socketAddress(socket), problems: z.prettifyError(parsed.error) },
        `${guard.name} socket sent an event that breaks its contract; dropped`,
      );
    });
  }
}

/** Closes a socket that sends more messages than its limit allows. */
export function limitMessages(socket: Socket, guard: SocketGuard): void {
  socket.use((_packet, next) => {
    if (guard.messages.hit(socket.id).allowed) return next();
    guard.logger.warn(
      { address: socketAddress(socket) },
      `${guard.name} socket sent too many messages`,
    );
    socket.disconnect(true);
  });
}
