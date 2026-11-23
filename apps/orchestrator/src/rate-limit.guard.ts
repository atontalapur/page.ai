import { HttpException, HttpStatus, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientAddress, RateLimiter } from './rate-limit.ts';

/**
 * Limits each client's requests to the routes it guards: past `limit` in a window, a request
 * gets 429 with `Retry-After` in seconds. Counted per address, the way the UI's files are,
 * and in memory per instance. Bound with `@UseGuards(new RateLimitGuard(...))`, so each use
 * counts on its own. It runs after the global API token guard, so a request without the
 * token gets its 401 first and isn't counted.
 */
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(limit: number, windowMs: number, now?: () => number) {
    this.limiter = new RateLimiter(limit, windowMs, now);
  }

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const address = clientAddress(request.socket.remoteAddress, request.headers['x-forwarded-for']);
    const { allowed, retryAfterMs } = this.limiter.hit(address);
    if (allowed) return true;
    http.getResponse<FastifyReply>().header('retry-after', String(Math.ceil(retryAfterMs / 1000)));
    throw new HttpException('rate limited', HttpStatus.TOO_MANY_REQUESTS);
  }
}
