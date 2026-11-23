import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../logger.ts';

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
  // A plugin of its own, so its reply decorators and routes stay apart from Nest's.
  await app.register(async (scope: FastifyInstance) => {
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
