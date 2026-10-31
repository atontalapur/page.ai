import type { Queryable } from '../../../db/index.ts';

/** 200 when the database answers, 503 otherwise, so Railway and compose can gate on it. */
export async function checkHealth(db: Queryable): Promise<Response> {
  try {
    await db.query('select 1');
    return Response.json({ status: 'ok', db: 'ok' });
  } catch {
    return Response.json({ status: 'error', db: 'unreachable' }, { status: 503 });
  }
}
