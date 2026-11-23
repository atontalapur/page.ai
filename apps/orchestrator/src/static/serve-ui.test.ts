import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { posthogWebhookFixture } from '@page/contracts/fixtures';
import { pino } from 'pino';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createTestDeps, testConfig } from '../db/test-utils.ts';
import { serveUi, UI_REQUESTS_PER_MINUTE } from './serve-ui.ts';

const INDEX = '<!doctype html><title>PageAgents</title><div id="root"></div>';
const SCRIPT = 'console.log("ui")';

const root = await mkdtemp(join(tmpdir(), 'page-ui-'));
await mkdir(join(root, 'assets'));
await writeFile(join(root, 'index.html'), INDEX);
await writeFile(join(root, 'assets', 'index-abc123.js'), SCRIPT);

const deps = await createTestDeps();
const app: NestFastifyApplication = await createApp(
  { ...deps, config: { ...testConfig, uiDistDir: root } },
  false,
);
await app.init();
await app.getHttpAdapter().getInstance().ready();
afterAll(async () => {
  await app.close();
  await deps.close();
  await rm(root, { recursive: true });
});

let addresses = 0;
type Method = 'GET' | 'POST';
/** A request from its own forwarded address, so the UI limit counts each test apart. */
function request(
  method: Method,
  url: string,
  headers: Record<string, string> = {},
  payload?: object,
) {
  const address = `192.0.2.${++addresses}`;
  return app.inject({ method, url, payload, headers: { 'x-forwarded-for': address, ...headers } });
}
const page = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const api = { authorization: `Bearer ${testConfig.apiToken ?? ''}` };

describe('the built UI', () => {
  it('serves index.html at / and on client routes, uncached', async () => {
    for (const url of ['/', '/incidents', `/incidents/${crypto.randomUUID()}`, '/agents/AG-001']) {
      const res = await request('GET', url, page);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.body).toBe(INDEX);
      expect(res.headers['cache-control']).toBe('public, max-age=0');
    }
  });

  it('serves the hashed files, cached for a year, with no token', async () => {
    const res = await request('GET', '/assets/index-abc123.js');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.body).toBe(SCRIPT);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers what is not a page with the JSON 404', async () => {
    for (const [url, headers] of [
      ['/assets/missing.js', page],
      ['/nothing-here', { accept: 'application/json' }],
      ['/nothing-here', {}],
    ] as const) {
      const res = await request('GET', url, headers);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404 });
    }
    expect((await request('POST', '/incidents', page)).statusCode).toBe(404);
  });

  it('leaves /health, the API and ingest as they were', async () => {
    const health = await request('GET', '/health', page);
    expect(health.json()).toEqual({ status: 'ok' });
    // A browser asking for the API still needs the token: the page fallback never sees it.
    expect((await request('GET', '/issues', page)).statusCode).toBe(401);
    expect((await request('GET', `/issues/${crypto.randomUUID()}`, page)).statusCode).toBe(401);
    const listed = await request('GET', '/issues', { ...page, ...api });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toBeInstanceOf(Array);
    const ingest = await request(
      'POST',
      '/ingest/posthog',
      { authorization: `Bearer ${testConfig.posthogWebhookSecret ?? ''}` },
      posthogWebhookFixture,
    );
    expect(ingest.statusCode).toBe(200);
  });

  it(`answers 429 past ${UI_REQUESTS_PER_MINUTE} UI requests a minute from one address`, async () => {
    const headers = { 'x-forwarded-for': '198.51.100.20', ...page };
    for (let i = 0; i < UI_REQUESTS_PER_MINUTE; i++) {
      expect((await app.inject({ method: 'GET', url: '/', headers })).statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'GET', url: '/incidents', headers });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // Only the UI's files count: the API and /health aren't limited here.
    expect((await app.inject({ method: 'GET', url: '/health', headers })).statusCode).toBe(200);
    // Another address has its own count.
    expect((await request('GET', '/', page)).statusCode).toBe(200);
  });
});

describe('without a build', () => {
  it('serves only the API, and says so', async () => {
    const lines: string[] = [];
    const logger = pino({}, { write: (line: string) => lines.push(line) });
    const bare = await createApp(deps, false);
    expect(await serveUi(bare, join(root, 'missing'), logger)).toBe(false);
    await bare.init();
    expect((await bare.inject({ method: 'GET', url: '/', headers: page })).statusCode).toBe(404);
    await bare.close();
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 40,
      msg: 'no UI build found; serving the API only',
    });
  });
});
