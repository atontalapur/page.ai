import { createHash } from 'node:crypto';
import {
  assertAgentBranch,
  GitHubError,
  type BranchHead,
  type FileMode,
  type GitHub,
  type NewCommit,
  type NewPullRequest,
  type PullRequest,
  type TreeEntry,
} from './github.ts';

interface FileEntry {
  mode: FileMode;
  blobSha: string;
}

interface Commit {
  treeSha: string;
  parents: string[];
  message: string;
}

export type FakeGitHubMethod = keyof GitHub;

const sha = (kind: string, content: string) =>
  createHash('sha1').update(`${kind}\0${content}`).digest('hex');

/**
 * A GitHub for tests and USE_FAKE_ADAPTERS. Holds blobs, trees, commits, branches and PRs in
 * memory and keeps GitHub's rules where the host tools lean on them: an unknown base tree
 * or parent is an error, a branch update must be a fast-forward, and a second open PR from
 * the same branch is refused. Add a method to `failOn` to make its next calls reject.
 */
export class FakeGitHub implements GitHub {
  readonly repo: string;
  readonly pullRequests: (NewPullRequest &
    PullRequest & { state: 'open' | 'closed'; comments: string[] })[] = [];
  /** Every call's method, in order, for asserting what ran. */
  readonly calls: FakeGitHubMethod[] = [];
  readonly failOn = new Set<FakeGitHubMethod>();
  private readonly blobs = new Map<string, string>();
  private readonly trees = new Map<string, Map<string, FileEntry>>();
  private readonly commits = new Map<string, Commit>();
  private readonly branches = new Map<string, string>();

  /** Starts the repo with one commit on `main` holding `files` (path to UTF-8 text). */
  constructor(files: Record<string, string> = {}, repo = 'page-demo/shop') {
    this.repo = repo;
    const tree = new Map<string, FileEntry>();
    for (const [path, text] of Object.entries(files)) {
      tree.set(path, { mode: '100644', blobSha: this.storeBlob(toBase64(text)) });
    }
    const commit = this.storeCommit({
      message: 'baseline',
      treeSha: this.storeTree(tree),
      parents: [],
    });
    this.branches.set('main', commit);
  }

  getBranch(name: string, signal?: AbortSignal): Promise<BranchHead | null> {
    return this.call('getBranch', signal, () => {
      const commitSha = this.branches.get(name);
      if (commitSha === undefined) return null;
      return { commitSha, treeSha: this.commit(commitSha).treeSha };
    });
  }

  mergeBase(base: string, head: string, signal?: AbortSignal): Promise<BranchHead> {
    return this.call('mergeBase', signal, () => {
      const baseSha = this.branches.get(base);
      const headSha = this.branches.get(head);
      if (baseSha === undefined || headSha === undefined) {
        throw new GitHubError('Not Found', 404);
      }
      const onBase = this.ancestors(baseSha);
      // Nearest first, so the first shared commit is the fork point.
      const queue = [headSha];
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        if (onBase.has(next)) return { commitSha: next, treeSha: this.commit(next).treeSha };
        queue.push(...this.commit(next).parents);
      }
      throw new GitHubError('No common ancestor', 404);
    });
  }

  createBlob(base64: string, signal?: AbortSignal): Promise<string> {
    return this.call('createBlob', signal, () => this.storeBlob(base64));
  }

  createTree(baseTreeSha: string, entries: TreeEntry[], signal?: AbortSignal): Promise<string> {
    return this.call('createTree', signal, () => {
      const base = this.trees.get(baseTreeSha);
      if (base === undefined) throw new GitHubError(`no tree ${baseTreeSha}`, 422);
      const tree = new Map(base);
      for (const { path, mode, sha: blobSha } of entries) {
        if (blobSha === null) {
          tree.delete(path);
          continue;
        }
        if (!this.blobs.has(blobSha)) throw new GitHubError(`no blob ${blobSha}`, 422);
        tree.set(path, { mode, blobSha });
      }
      return this.storeTree(tree);
    });
  }

  createCommit(commit: NewCommit, signal?: AbortSignal): Promise<string> {
    return this.call('createCommit', signal, () => {
      if (!this.trees.has(commit.treeSha)) throw new GitHubError(`no tree ${commit.treeSha}`, 422);
      for (const parent of commit.parents) this.commit(parent);
      return this.storeCommit(commit);
    });
  }

  createBranch(name: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    return this.call('createBranch', signal, () => {
      assertAgentBranch(name);
      if (this.branches.has(name)) throw new GitHubError('Reference already exists', 422);
      this.commit(commitSha);
      this.branches.set(name, commitSha);
    });
  }

  updateBranch(name: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    return this.call('updateBranch', signal, () => {
      assertAgentBranch(name);
      const current = this.branches.get(name);
      if (current === undefined) throw new GitHubError('Reference does not exist', 422);
      if (!this.isAncestor(current, commitSha)) {
        throw new GitHubError('Update is not a fast forward', 422);
      }
      this.branches.set(name, commitSha);
    });
  }

  findOpenPullRequest(head: string, signal?: AbortSignal): Promise<PullRequest | null> {
    return this.call('findOpenPullRequest', signal, () => {
      const pr = this.pullRequests.find((p) => p.head === head && p.state === 'open');
      return pr === undefined ? null : { number: pr.number, url: pr.url };
    });
  }

  createPullRequest(pr: NewPullRequest, signal?: AbortSignal): Promise<PullRequest> {
    return this.call('createPullRequest', signal, () => {
      assertAgentBranch(pr.head);
      if (!this.branches.has(pr.head) || !this.branches.has(pr.base)) {
        throw new GitHubError('Validation Failed: head or base does not exist', 422);
      }
      if (this.pullRequests.some((p) => p.head === pr.head && p.state === 'open')) {
        throw new GitHubError(`A pull request already exists for ${pr.head}`, 422);
      }
      const number = this.pullRequests.length + 1;
      const created = { number, url: `https://github.com/${this.repo}/pull/${number}` };
      this.pullRequests.push({ ...pr, ...created, state: 'open', comments: [] });
      return created;
    });
  }

  closePullRequest(number: number, comment: string, signal?: AbortSignal): Promise<void> {
    return this.call('closePullRequest', signal, () => {
      const pr = this.pullRequests.find((p) => p.number === number);
      if (pr === undefined) throw new GitHubError('Not Found', 404);
      pr.comments.push(comment);
      pr.state = 'closed';
    });
  }

  /** Commits `files` (path to UTF-8 text) onto `branch`, as someone merging to it would. */
  advance(branch: string, files: Record<string, string>): string {
    const head = this.branches.get(branch);
    if (head === undefined) throw new Error(`no branch ${branch}`);
    const tree = new Map(this.trees.get(this.commit(head).treeSha));
    for (const [path, text] of Object.entries(files)) {
      tree.set(path, { mode: '100644', blobSha: this.storeBlob(toBase64(text)) });
    }
    const commit = this.storeCommit({
      message: 'advance',
      treeSha: this.storeTree(tree),
      parents: [head],
    });
    this.branches.set(branch, commit);
    return commit;
  }

  /** The branch's head commit, for assertions. */
  head(branch: string): string | undefined {
    return this.branches.get(branch);
  }

  /** A commit's message and parents, for assertions. */
  commitInfo(commitSha: string): { message: string; parents: string[] } {
    const { message, parents } = this.commit(commitSha);
    return { message, parents };
  }

  /** Path to `{ mode, text }` at the branch head, for assertions. */
  files(branch: string): Record<string, { mode: FileMode; text: string }> {
    const commitSha = this.branches.get(branch);
    if (commitSha === undefined) throw new Error(`no branch ${branch}`);
    const tree = this.trees.get(this.commit(commitSha).treeSha)!;
    const out: Record<string, { mode: FileMode; text: string }> = {};
    for (const [path, { mode, blobSha }] of tree) {
      out[path] = { mode, text: Buffer.from(this.blobs.get(blobSha)!, 'base64').toString() };
    }
    return out;
  }

  private call<T>(
    method: FakeGitHubMethod,
    signal: AbortSignal | undefined,
    body: () => T,
  ): Promise<T> {
    this.calls.push(method);
    if (signal?.aborted) {
      return Promise.reject(new GitHubError(`GitHub API ${method} failed: aborted`));
    }
    if (this.failOn.has(method)) {
      return Promise.reject(new GitHubError('GitHub API answered 503: unavailable', 503));
    }
    try {
      return Promise.resolve(body());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private commit(commitSha: string): Commit {
    const commit = this.commits.get(commitSha);
    if (commit === undefined) throw new GitHubError(`no commit ${commitSha}`, 422);
    return commit;
  }

  private ancestors(of: string): Set<string> {
    const seen = new Set<string>();
    const queue = [of];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.commit(next).parents);
    }
    return seen;
  }

  private isAncestor(ancestor: string, of: string): boolean {
    return this.ancestors(of).has(ancestor);
  }

  private storeBlob(base64: string): string {
    const blobSha = sha('blob', base64);
    this.blobs.set(blobSha, base64);
    return blobSha;
  }

  private storeTree(tree: Map<string, FileEntry>): string {
    const listing = [...tree]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, { mode, blobSha }]) => `${mode} ${blobSha} ${path}`)
      .join('\n');
    const treeSha = sha('tree', listing);
    this.trees.set(treeSha, tree);
    return treeSha;
  }

  private storeCommit(commit: NewCommit): string {
    const commitSha = sha(
      'commit',
      `${commit.treeSha}\n${commit.parents.join(' ')}\n${commit.message}\n${this.commits.size}`,
    );
    this.commits.set(commitSha, { ...commit });
    return commitSha;
  }
}

const toBase64 = (text: string) => Buffer.from(text).toString('base64');
