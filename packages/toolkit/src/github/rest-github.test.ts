import { describe, expect, it, vi } from 'vitest';
import { GitHubError } from './github.ts';
import { GITHUB_API, RestGitHub } from './rest-github.ts';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;

function setup(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) return Promise.reject(reply);
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    return Promise.resolve(new Response(text, { status: reply.status ?? 200 }));
  });
  const github = new RestGitHub({
    token: 'tok',
    repo: 'acme/shop',
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { github, sent };
}

describe('RestGitHub', () => {
  it('reads a branch head and its tree, with the token and API version', async () => {
    const { github, sent } = setup({
      body: { commit: { sha: 'c1', commit: { tree: { sha: 't1' } } } },
    });
    expect(await github.getBranch('pageagents/run-1')).toEqual({ commitSha: 'c1', treeSha: 't1' });
    expect(sent[0]).toMatchObject({
      url: `${GITHUB_API}/repos/acme/shop/branches/pageagents/run-1`,
      method: 'GET',
      headers: {
        authorization: 'Bearer tok',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    expect(sent[0]!.headers).not.toHaveProperty('content-type');
  });

  it('reads a missing branch as null', async () => {
    const { github } = setup({ status: 404, body: { message: 'Branch not found' } });
    expect(await github.getBranch('main')).toBeNull();
  });

  it('creates a blob, a tree over a base and a commit', async () => {
    const { github, sent } = setup(
      { status: 201, body: { sha: 'b1' } },
      { status: 201, body: { sha: 't2' } },
      { status: 201, body: { sha: 'c2' } },
    );
    expect(await github.createBlob('aGk=')).toBe('b1');
    expect(
      await github.createTree('t1', [
        { path: 'a.ts', mode: '100644', sha: 'b1' },
        { path: 'gone.ts', mode: '100644', sha: null },
      ]),
    ).toBe('t2');
    expect(await github.createCommit({ message: 'fix', treeSha: 't2', parents: ['c1'] })).toBe(
      'c2',
    );
    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: 'POST',
        url: `${GITHUB_API}/repos/acme/shop/git/blobs`,
        body: { content: 'aGk=', encoding: 'base64' },
      },
      {
        method: 'POST',
        url: `${GITHUB_API}/repos/acme/shop/git/trees`,
        body: {
          base_tree: 't1',
          tree: [
            { path: 'a.ts', mode: '100644', type: 'blob', sha: 'b1' },
            { path: 'gone.ts', mode: '100644', type: 'blob', sha: null },
          ],
        },
      },
      {
        method: 'POST',
        url: `${GITHUB_API}/repos/acme/shop/git/commits`,
        body: { message: 'fix', tree: 't2', parents: ['c1'] },
      },
    ]);
    expect(sent[0]!.headers['content-type']).toBe('application/json');
  });

  it('creates a branch, and moves one without forcing', async () => {
    const { github, sent } = setup({ status: 201 }, { status: 200 });
    await github.createBranch('pageagents/run-1', 'c1');
    await github.updateBranch('pageagents/run-1', 'c2');
    expect(sent.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      {
        method: 'POST',
        url: `${GITHUB_API}/repos/acme/shop/git/refs`,
        body: { ref: 'refs/heads/pageagents/run-1', sha: 'c1' },
      },
      {
        method: 'PATCH',
        url: `${GITHUB_API}/repos/acme/shop/git/refs/heads/pageagents/run-1`,
        body: { sha: 'c2', force: false },
      },
    ]);
  });

  it('refuses to write a branch outside pageagents/ without sending anything', async () => {
    const { github, sent } = setup();
    await expect(github.createBranch('main', 'c1')).rejects.toThrow(/not a pageagents\/\* branch/);
    await expect(github.updateBranch('pageagents/', 'c1')).rejects.toThrow(GitHubError);
    await expect(github.updateBranch('pageagents/../main', 'c1')).rejects.toThrow(GitHubError);
    await expect(
      github.createPullRequest({ title: 't', body: 'b', head: 'fix', base: 'main' }),
    ).rejects.toThrow(GitHubError);
    expect(sent).toEqual([]);
  });

  it('finds the open PR from a branch by owner:branch', async () => {
    const { github, sent } = setup(
      { body: [{ number: 7, html_url: 'https://github.com/acme/shop/pull/7' }] },
      { body: [] },
    );
    expect(await github.findOpenPullRequest('pageagents/run-1')).toEqual({
      number: 7,
      url: 'https://github.com/acme/shop/pull/7',
    });
    expect(await github.findOpenPullRequest('pageagents/run-2')).toBeNull();
    expect(sent[0]!.url).toBe(
      `${GITHUB_API}/repos/acme/shop/pulls?state=open&head=acme%3Apageagents%2Frun-1&per_page=1`,
    );
  });

  it('opens a PR', async () => {
    const { github, sent } = setup({
      status: 201,
      body: { number: 3, html_url: 'https://github.com/acme/shop/pull/3', extra: true },
    });
    const pr = { title: 'fix', body: 'why', head: 'pageagents/run-1', base: 'main' };
    expect(await github.createPullRequest(pr)).toEqual({
      number: 3,
      url: 'https://github.com/acme/shop/pull/3',
    });
    expect(sent[0]).toMatchObject({ method: 'POST', body: pr });
  });

  it('turns an error reply into a GitHubError with the status and message', async () => {
    const { github } = setup(
      { status: 422, body: { message: 'Update is not a fast forward' } },
      { status: 500, body: 'not json' },
    );
    const error = await github.updateBranch('pageagents/run-1', 'c2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error).toMatchObject({
      status: 422,
      message: 'GitHub API answered 422: Update is not a fast forward',
    });
    await expect(github.createBlob('x')).rejects.toThrow(/^GitHub API answered 500$/);
  });

  it('turns a failed fetch into a GitHubError with no status', async () => {
    const { github } = setup(new Error('socket hang up'));
    await expect(github.createBlob('x')).rejects.toMatchObject({
      status: null,
      message: expect.stringContaining('socket hang up') as string,
    });
  });

  it('rejects a reply that is missing what it needs', async () => {
    const { github } = setup({ status: 201, body: { nope: 1 } });
    await expect(github.createBlob('x')).rejects.toThrow();
  });

  it('wants an owner/name repo', () => {
    expect(() => new RestGitHub({ token: 't', repo: 'shop' })).toThrow(/owner\/name/);
    expect(() => new RestGitHub({ token: 't', repo: 'a/b/c' })).toThrow(/owner\/name/);
  });
});
