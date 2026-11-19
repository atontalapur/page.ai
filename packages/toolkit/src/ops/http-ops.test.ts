import { describe, expect, it } from 'vitest';
import { HttpOps } from './http-ops.ts';
import { OpsError } from './ops.ts';

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: string | null;
}

/** A fetch that answers each request from `answers` in turn, logging what it was asked. */
function fakeFetch(answers: (Response | Error)[]) {
  const seen: Seen[] = [];
  const doFetch = (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      method: init?.method ?? 'GET',
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const next = answers.shift();
    if (next === undefined) return Promise.reject(new Error('no answer left'));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { seen, fetch: doFetch };
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const fast = { restartGraceMs: 0, healthPollMs: 1 };

describe('HttpOps', () => {
  it('calls the ops API with the secret, and parses JSON or keeps text', async () => {
    const { seen, fetch } = fakeFetch([
      json(200, { settings: {} }),
      json(200, { key: 'SHIPPING_FLAT_CENTS', to: '500' }),
      new Response('not json', { status: 500 }),
    ]);
    const ops = new HttpOps({ url: 'http://app:3000/', secret: 's3', fetch });
    expect(await ops.getConfig()).toEqual({ status: 200, body: { settings: {} } });
    expect(await ops.setConfig('SHIPPING_FLAT_CENTS', '500')).toEqual({
      status: 200,
      body: { key: 'SHIPPING_FLAT_CENTS', to: '500' },
    });
    expect(await ops.deleteConfig('SHIPPING_FLAT_CENTS')).toEqual({
      status: 500,
      body: 'not json',
    });
    expect(seen).toEqual([
      { method: 'GET', url: 'http://app:3000/api/ops/config', auth: 'Bearer s3', body: null },
      {
        method: 'PUT',
        url: 'http://app:3000/api/ops/config/SHIPPING_FLAT_CENTS',
        auth: 'Bearer s3',
        body: '{"value":"500"}',
      },
      {
        method: 'DELETE',
        url: 'http://app:3000/api/ops/config/SHIPPING_FLAT_CENTS',
        auth: 'Bearer s3',
        body: null,
      },
    ]);
  });

  it('waits for /api/health after a 202 restart', async () => {
    const { seen, fetch } = fakeFetch([
      json(202, { restarting: true }),
      new Error('connection refused'),
      new Response('', { status: 503 }),
      json(200, { ok: true }),
    ]);
    const reply = await new HttpOps({ url: 'http://app', secret: 's', fetch, ...fast }).restart();
    expect(reply).toMatchObject({
      status: 202,
      body: { restarting: true },
      healthy: { ok: true },
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST http://app/api/ops/restart',
      'GET http://app/api/health',
      'GET http://app/api/health',
      'GET http://app/api/health',
    ]);
  });

  it('does not wait when the app refuses the restart', async () => {
    const { seen, fetch } = fakeFetch([json(409, { error: 'settings_invalid' })]);
    const reply = await new HttpOps({ url: 'http://app', secret: 's', fetch, ...fast }).restart();
    expect(reply).toEqual({ status: 409, body: { error: 'settings_invalid' } });
    expect(seen).toHaveLength(1);
  });

  it('says the app never came back when health runs out of time', async () => {
    const { fetch } = fakeFetch([
      json(202, {}),
      ...Array.from({ length: 50 }, () => new Error('down')),
    ]);
    const ops = new HttpOps({
      url: 'http://app',
      secret: 's',
      fetch,
      ...fast,
      healthTimeoutMs: 20,
    });
    expect((await ops.restart()).healthy?.ok).toBe(false);
  });

  it('throws OpsError when the app is unreachable, and the abort reason when stopped', async () => {
    const down = new HttpOps({
      url: 'http://app',
      secret: 's',
      fetch: fakeFetch([new Error('ECONNREFUSED')]).fetch,
    });
    await expect(down.getConfig()).rejects.toThrow(OpsError);

    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    const stopped = new HttpOps({
      url: 'http://app',
      secret: 's',
      fetch: fakeFetch([new Error('aborted')]).fetch,
    });
    await expect(stopped.getConfig(stop.signal)).rejects.toThrow('stopped');
  });
});
