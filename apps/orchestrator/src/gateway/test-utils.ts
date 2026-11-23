import { io, type Socket } from 'socket.io-client';

/**
 * Opens sockets to one namespace that don't retry, so a test sees each refusal. Each gets its
 * own forwarded address unless given one, so the handshake limit counts every test apart.
 */
export class TestSockets {
  private readonly open: Socket[] = [];
  private addresses = 0;

  constructor(
    private readonly url: string,
    /** The first three parts of the addresses handed out, e.g. `203.0.113`. */
    private readonly network: string,
  ) {}

  connect(auth: Record<string, unknown>, address = `${this.network}.${++this.addresses}`): Socket {
    const socket = io(this.url, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { 'x-forwarded-for': address },
    });
    this.open.push(socket);
    return socket;
  }

  /** For afterEach. */
  closeAll(): void {
    for (const socket of this.open.splice(0)) socket.close();
  }
}

/** Resolves with the `connect_error` message, or `connected`. */
export function outcome(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('connect', () => resolve('connected'));
    socket.once('connect_error', (err) => resolve(err.message));
  });
}
