import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '../../../db/index.ts';
import { testShop, type TestShop } from '../../test-utils.ts';
import { checkHealth } from './health.ts';
import { GET } from './route.ts';

const h = vi.hoisted(() => ({ ctx: undefined as unknown as TestShop }));
vi.mock('../../data.ts', () => ({ shop: () => Promise.resolve(h.ctx) }));

describe('GET /api/health', () => {
  it('reports ok when the database answers', async () => {
    h.ctx = await testShop();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });
  });

  it('returns 503 when the database is down', async () => {
    const down: Queryable = {
      query: () => Promise.reject(new Error('ECONNREFUSED')),
      exec: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    const res = await checkHealth(down);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'error', db: 'unreachable' });
  });
});
