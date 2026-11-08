import { describe, expect, it } from 'vitest';
import { FakeGitHub } from './fake-github.ts';
import { GitHubError } from './github.ts';

const b64 = (text: string) => Buffer.from(text).toString('base64');

async function commitOn(github: FakeGitHub, branch: string, files: Record<string, string>) {
  const head = (await github.getBranch(branch))!;
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      mode: '100644' as const,
      sha: await github.createBlob(b64(text)),
    })),
  );
  const treeSha = await github.createTree(head.treeSha, entries);
  return github.createCommit({ message: 'change', treeSha, parents: [head.commitSha] });
}

describe('FakeGitHub', () => {
  it('starts with main holding the given files', async () => {
    const github = new FakeGitHub({ 'a.ts': 'one' });
    expect(github.files('main')).toEqual({ 'a.ts': { mode: '100644', text: 'one' } });
    expect(await github.getBranch('pageagents/x')).toBeNull();
    expect(() => github.files('nope')).toThrow(/no branch/);
  });

  it('writes a tree over its base, deleting null entries', async () => {
    const github = new FakeGitHub({ 'a.ts': 'one', 'b.ts': 'two' });
    const head = (await github.getBranch('main'))!;
    const blob = await github.createBlob(b64('new'));
    const treeSha = await github.createTree(head.treeSha, [
      { path: 'a.ts', mode: '100755', sha: blob },
      { path: 'b.ts', mode: '100644', sha: null },
    ]);
    const commit = await github.createCommit({ message: 'm', treeSha, parents: [head.commitSha] });
    await github.createBranch('pageagents/x', commit);
    expect(github.files('pageagents/x')).toEqual({ 'a.ts': { mode: '100755', text: 'new' } });
    expect(github.head('pageagents/x')).toBe(commit);
    expect(github.commitInfo(commit)).toEqual({ message: 'm', parents: [head.commitSha] });
  });

  it('refuses unknown trees, blobs and parents', async () => {
    const github = new FakeGitHub();
    const head = (await github.getBranch('main'))!;
    await expect(github.createTree('nope', [])).rejects.toThrow(GitHubError);
    await expect(
      github.createTree(head.treeSha, [{ path: 'a', mode: '100644', sha: 'nope' }]),
    ).rejects.toThrow(/no blob/);
    await expect(
      github.createCommit({ message: 'm', treeSha: 'nope', parents: [] }),
    ).rejects.toThrow(/no tree/);
    await expect(
      github.createCommit({ message: 'm', treeSha: head.treeSha, parents: ['nope'] }),
    ).rejects.toThrow(/no commit/);
    await expect(github.createBranch('pageagents/x', 'nope')).rejects.toThrow(/no commit/);
  });

  it('only fast-forwards a branch, and only pageagents/ branches', async () => {
    const github = new FakeGitHub({ 'a.ts': 'one' });
    const first = await commitOn(github, 'main', { 'a.ts': 'two' });
    await github.createBranch('pageagents/x', first);
    await expect(github.createBranch('pageagents/x', first)).rejects.toThrow(/already exists/);

    const second = await commitOn(github, 'pageagents/x', { 'a.ts': 'three' });
    await github.updateBranch('pageagents/x', second);
    expect(github.files('pageagents/x')['a.ts']!.text).toBe('three');

    const sideways = await commitOn(github, 'main', { 'a.ts': 'other' });
    await expect(github.updateBranch('pageagents/x', sideways)).rejects.toThrow(/fast forward/);
    await expect(github.updateBranch('pageagents/y', second)).rejects.toThrow(/does not exist/);
    await expect(github.createBranch('main', first)).rejects.toThrow(/not a pageagents/);
  });

  it('opens one PR per branch and finds it again', async () => {
    const github = new FakeGitHub({ 'a.ts': 'one' });
    const commit = await commitOn(github, 'main', { 'a.ts': 'two' });
    await github.createBranch('pageagents/x', commit);
    const pr = { title: 't', body: 'b', head: 'pageagents/x', base: 'main' };

    expect(await github.findOpenPullRequest('pageagents/x')).toBeNull();
    expect(await github.createPullRequest(pr)).toEqual({
      number: 1,
      url: 'https://github.com/page-demo/shop/pull/1',
    });
    expect(await github.findOpenPullRequest('pageagents/x')).toMatchObject({ number: 1 });
    await expect(github.createPullRequest(pr)).rejects.toThrow(/already exists/);
    await expect(github.createPullRequest({ ...pr, head: 'pageagents/y' })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('rejects a method listed in failOn', async () => {
    const github = new FakeGitHub();
    github.failOn.add('getBranch');
    await expect(github.getBranch('main')).rejects.toMatchObject({ status: 503 });
    github.failOn.clear();
    expect(await github.getBranch('main')).not.toBeNull();
  });
});
