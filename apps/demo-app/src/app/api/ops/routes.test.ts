import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../../db/index.ts';
import { createTestDb } from '../../../db/test-utils.ts';
import { readRuntimeConfig } from '../../../ops/runtime-config.ts';
import { DELETE, PUT } from './config/[key]/route.ts';
import { GET } from './config/route.ts';
import { POST } from './restart/route.ts';

const h = vi.hoisted(() => ({ db: undefined as unknown as Db, exit: vi.fn() }));
vi.mock('../../../db/index.ts', () => ({ getDb: () => h.db }));
vi.mock('../../data.ts', () => ({ loadedSettings: () => undefined }));

const SECRET = 'r'.repeat(40);
const headers = { authorization: `Bearer ${SECRET}` };
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });

describe('ops routes', () => {
  it('wire the handlers to the database and OPS_SECRET', async () => {
    vi.stubEnv('OPS_SECRET', SECRET);
    h.db = await createTestDb();
    const url = 'http://localhost/api/ops/config/MAX_ITEM_QUANTITY';

    const put = await PUT(
      new Request(url, { method: 'PUT', headers, body: '{"value":"3"}' }),
      ctx('MAX_ITEM_QUANTITY'),
    );
    expect(put.status).toBe(200);
    expect(await readRuntimeConfig(h.db)).toEqual({ MAX_ITEM_QUANTITY: '3' });

    const get = await GET(new Request('http://localhost/api/ops/config', { headers }));
    expect(await get.json()).toMatchObject({ current: null });

    await DELETE(new Request(url, { method: 'DELETE', headers }), ctx('MAX_ITEM_QUANTITY'));
    expect(await readRuntimeConfig(h.db)).toEqual({});

    const restart = 'http://localhost/api/ops/restart?dryRun=true';
    expect((await POST(new Request(restart, { method: 'POST', headers }))).status).toBe(200);
    vi.unstubAllEnvs();
  });
});
