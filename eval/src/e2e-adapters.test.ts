import type { SqlClient } from '@page/toolkit';
import { describe, expect, it } from 'vitest';
import { OrchestratorControl, PgPipelineReader, realClock } from './e2e-adapters.ts';

const RUN = '00000000-0000-4000-8000-0000000000a1';
const at = new Date('2026-11-15T10:00:00Z');

const issue = {
  id: '00000000-0000-4000-8000-000000000001',
  fingerprint: 'ph-1',
  title: 'RangeError: Invalid currency code : US',
  status: 'fixing',
  class: 'frontend',
  severity: 'high',
  current_tier: 1,
  current_run_id: RUN,
  occurrences: 2,
  created_at: at,
  last_seen_at: at,
};

/** Answers each query with the rows of the first entry whose key it contains. */
function fakeDb(answers: Record<string, unknown[]>) {
  const queries: { text: string; params: unknown[] }[] = [];
  const db: SqlClient = {
    query: (text, params) => {
      queries.push({ text, params });
      const key = Object.keys(answers).find((k) => text.includes(k));
      if (key === undefined) return Promise.reject(new Error(`unexpected query: ${text}`));
      const rows = answers[key]!;
      return Promise.resolve({ rowCount: rows.length, rows });
    },
  };
  return { db, queries };
}

describe('PgPipelineReader', () => {
  it('maps issue rows', async () => {
    const { db, queries } = fakeDb({ 'from issues where last_seen_at': [issue] });
    const rows = await new PgPipelineReader(db).issuesSeenSince(at);
    expect(rows).toEqual([
      {
        id: issue.id,
        fingerprint: 'ph-1',
        title: issue.title,
        status: 'fixing',
        class: 'frontend',
        severity: 'high',
        currentTier: 1,
        currentRunId: RUN,
        occurrences: 2,
        createdAt: at,
        lastSeenAt: at,
      },
    ]);
    expect(queries[0]!.params).toEqual([at]);
  });

  it('returns null for a missing issue and rejects a row it does not know', async () => {
    expect(await new PgPipelineReader(fakeDb({ 'where id': [] }).db).issue(issue.id)).toBeNull();
    const bad = fakeDb({ 'where id': [{ ...issue, status: 'lost' }] }).db;
    await expect(new PgPipelineReader(bad).issue(issue.id)).rejects.toThrow();
  });

  it('reads the database clock', async () => {
    expect(await new PgPipelineReader(fakeDb({ 'now()': [{ now: at }] }).db).now()).toEqual(at);
  });

  it('puts a run together from runs, steps, approvals and the pg-boss job', async () => {
    const { db, queries } = fakeDb({
      'from runs': [
        {
          id: RUN,
          tier: 2,
          status: 'succeeded',
          started_at: at,
          finished_at: at,
          pr_url: 'https://github.com/o/r/pull/1',
        },
      ],
      'from steps': [{ n: 12 }],
      'from approvals': [{ n: 0 }],
      'from boss.job': [{ state: 'completed' }],
    });
    const progress = await new PgPipelineReader(db, { pgbossSchema: 'boss' }).run(RUN);
    expect(progress).toEqual({
      runId: RUN,
      run: {
        id: RUN,
        tier: 2,
        status: 'succeeded',
        startedAt: at,
        finishedAt: at,
        prUrl: 'https://github.com/o/r/pull/1',
      },
      jobState: 'completed',
      steps: 12,
      pendingApprovals: 0,
    });
    expect(queries.find((q) => q.text.includes('boss.job'))!.params).toEqual(['fix', RUN]);
  });

  it('reports a run with no row and no job yet', async () => {
    const { db } = fakeDb({
      'from runs': [],
      'from steps': [{ n: 0 }],
      'from approvals': [{ n: 1 }],
      'from pgboss.job': [],
    });
    expect(await new PgPipelineReader(db).run(RUN)).toEqual({
      runId: RUN,
      run: null,
      jobState: null,
      steps: 0,
      pendingApprovals: 1,
    });
  });

  it('refuses a pg-boss schema that is not a plain name', () => {
    expect(() => new PgPipelineReader(fakeDb({}).db, { pgbossSchema: 'x; drop' })).toThrow(
      /plain schema name/,
    );
  });
});

describe('OrchestratorControl', () => {
  it('posts a kill event', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFake: typeof fetch = (url, init) => {
      calls.push({ url: url instanceof Request ? url.url : url.toString(), init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    await new OrchestratorControl('https://orch.example/', fetchFake).killIssue('abc');
    expect(calls[0]!.url).toBe('https://orch.example/issues/abc/events');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"type":"kill"}' });
  });

  it('throws with the status and body on an error answer', async () => {
    const fetchFake: typeof fetch = () =>
      Promise.resolve(new Response('cannot kill an issue that is killed', { status: 409 }));
    await expect(new OrchestratorControl('http://o', fetchFake).killIssue('abc')).rejects.toThrow(
      'POST /issues/abc/events answered 409: cannot kill an issue that is killed',
    );
    const empty: typeof fetch = () => Promise.resolve(new Response(null, { status: 500 }));
    await expect(new OrchestratorControl('http://o', empty).killIssue('abc')).rejects.toThrow(
      /answered 500$/,
    );
  });
});

describe('realClock', () => {
  it('sleeps and can be woken by its signal', async () => {
    const before = realClock.now();
    await realClock.sleep(5);
    expect(realClock.now()).toBeGreaterThanOrEqual(before + 4);

    const stop = new AbortController();
    const sleeping = realClock.sleep(60_000, stop.signal);
    stop.abort(new Error('stopped'));
    await expect(sleeping).rejects.toThrow('stopped');
    await expect(realClock.sleep(1, stop.signal)).rejects.toThrow('stopped');
  });
});
