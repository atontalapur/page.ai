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
  readonly pullRequests: (NewPullRequest & PullRequest)[] = [];
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

  getBranch(name: string): Promise<BranchHead | null> {
    return this.call('getBranch', () => {
      const commitSha = this.branches.get(name);
      if (commitSha === undefined) return null;
      return { commitSha, treeSha: this.commit(commitSha).treeSha };
    });
  }

  createBlob(base64: string): Promise<string> {
    return this.call('createBlob', () => this.storeBlob(base64));
  }

  createTree(baseTreeSha: string, entries: TreeEntry[]): Promise<string> {
    return this.call('createTree', () => {
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

  createCommit(commit: NewCommit): Promise<string> {
    return this.call('createCommit', () => {
      if (!this.trees.has(commit.treeSha)) throw new GitHubError(`no tree ${commit.treeSha}`, 422);
      for (const parent of commit.parents) this.commit(parent);
      return this.storeCommit(commit);
    });
  }

  createBranch(name: string, commitSha: string): Promise<void> {
    return this.call('createBranch', () => {
      assertAgentBranch(name);
      if (this.branches.has(name)) throw new GitHubError('Reference already exists', 422);
      this.commit(commitSha);
      this.branches.set(name, commitSha);
    });
  }

  updateBranch(name: string, commitSha: string): Promise<void> {
    return this.call('updateBranch', () => {
      assertAgentBranch(name);
      const current = this.branches.get(name);
      if (current === undefined) throw new GitHubError('Reference does not exist', 422);
      if (!this.isAncestor(current, commitSha)) {
        throw new GitHubError('Update is not a fast forward', 422);
      }
      this.branches.set(name, commitSha);
    });
  }

  findOpenPullRequest(head: string): Promise<PullRequest | null> {
    return this.call('findOpenPullRequest', () => {
      const pr = this.pullRequests.find((p) => p.head === head);
      return pr === undefined ? null : { number: pr.number, url: pr.url };
    });
  }

  createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    return this.call('createPullRequest', () => {
      assertAgentBranch(pr.head);
      if (!this.branches.has(pr.head) || !this.branches.has(pr.base)) {
        throw new GitHubError('Validation Failed: head or base does not exist', 422);
      }
      if (this.pullRequests.some((p) => p.head === pr.head)) {
        throw new GitHubError(`A pull request already exists for ${pr.head}`, 422);
      }
      const number = this.pullRequests.length + 1;
      const created = { number, url: `https://github.com/${this.repo}/pull/${number}` };
      this.pullRequests.push({ ...pr, ...created });
      return created;
    });
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

  private call<T>(method: FakeGitHubMethod, body: () => T): Promise<T> {
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

  private isAncestor(ancestor: string, of: string): boolean {
    const queue = [of];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (next === ancestor) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...this.commit(next).parents);
    }
    return false;
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
