import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../logger.ts';
import { clientAddress, RateLimiter } from '../rate-limit.ts';

// A page load is index.html and about ten hashed files (the script, the stylesheet, the
// fonts), so 300 a minute is about 30 full reloads. Past that a client gets 429s until its
// minute is up. The files are public, so the API token can't bound this.
export const UI_REQUESTS_PER_MINUTE = 300;

/**
 * A browser asking for a page (not a script, an image or an API response), the way
 * connect-history-api-fallback decides: HTML is acceptable and the last path segment has no
 * file extension.
 */
function wantsPage(accept: string | undefined, url: string): boolean {
  const last = url.split('?')[0]?.split('/').at(-1) ?? '';
  return (accept ?? '').includes('text/html') && !last.includes('.');
}

/**
 * Serves the built UI at `/`, without the API token, from the same origin as the API and the
 * socket. Hashed files under the build are served as they are, cached for a year. Any other
 * GET a browser makes for a page gets index.html, uncached, so a reload on a client route such
 * as `/incidents/:id` works.
 *
 * Nothing here shadows the API: Fastify matches every Nest route before the wildcard, and a
 * request the wildcard catches that isn't for a page (curl, fetch, a missing asset) falls
 * through to Nest's JSON 404. Returns false, and serves nothing, when `root` has no build.
 */
export async function serveUi(
  app: NestFastifyApplication,
  root: string,
  logger: Logger,
): Promise<boolean> {
  if (!existsSync(join(root, 'index.html'))) {
    logger.warn({ root }, 'no UI build found; serving the API only');
    return false;
  }
  const limiter = new RateLimiter(UI_REQUESTS_PER_MINUTE, 60_000);
  // A plugin of its own, so the limit and the routes apply only to the UI's files.
  await app.register(async (scope: FastifyInstance) => {
    scope.addHook('onRequest', async (request, reply) => {
      const address = clientAddress(
        request.socket.remoteAddress,
        request.headers['x-forwarded-for'],
      );
      const { allowed, retryAfterMs } = limiter.hit(address);
      if (allowed) return;
      await reply
        .code(429)
        .header('retry-after', String(Math.ceil(retryAfterMs / 1000)))
        .send({ statusCode: 429, error: 'Too Many Requests', message: 'rate limited' });
    });
    await scope.register(fastifyStatic, {
      root,
      // One route per file in the build, found at boot, so no wildcard competes with the
      // fallback below. index.html is served by the fallback alone, never cached.
      wildcard: false,
      index: false,
      globIgnore: ['index.html'],
      maxAge: '1y',
      immutable: true,
    });
    scope.get('/*', (request, reply) => {
      if (!wantsPage(request.headers.accept, request.url)) return reply.callNotFound();
      return reply.sendFile('index.html', { maxAge: 0, immutable: false });
    });
  });
  logger.info({ root }, 'serving the UI');
  return true;
}
