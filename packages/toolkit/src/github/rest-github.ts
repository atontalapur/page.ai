import { z } from 'zod';
import {
  assertAgentBranch,
  GitHubError,
  type BranchHead,
  type GitHub,
  type NewCommit,
  type NewPullRequest,
  type PullRequest,
  type TreeEntry,
} from './github.ts';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_TIMEOUT_MS = 15_000;
const API_VERSION = '2022-11-28';

export interface RestGitHubOptions {
  /** A fine-grained token for `repo` alone: contents and pull requests, read and write. */
  token: string;
  /** `owner/name`. */
  repo: string;
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const shaReply = z.object({ sha: z.string() });
const branchReply = z.object({
  commit: z.object({ sha: z.string(), commit: z.object({ tree: z.object({ sha: z.string() }) }) }),
});
const pullReply = z.object({ number: z.int(), html_url: z.string() });
const compareReply = z.object({
  merge_base_commit: z.object({
    sha: z.string(),
    commit: z.object({ tree: z.object({ sha: z.string() }) }),
  }),
});
const errorReply = z.object({ message: z.string() }).loose();

// A branch name has slashes; GitHub takes them unencoded in these paths.
const refPath = (name: string) => name.split('/').map(encodeURIComponent).join('/');

const toPull = ({ number, html_url }: z.infer<typeof pullReply>): PullRequest => ({
  number,
  url: html_url,
});

/** GitHub over its REST API, for one repository. */
export class RestGitHub implements GitHub {
  private readonly options: RestGitHubOptions;
  private readonly owner: string;

  constructor(options: RestGitHubOptions) {
    const [owner, name, ...rest] = options.repo.split('/');
    if (!owner || !name || rest.length > 0) {
      throw new Error(`GitHub repo must be owner/name, not ${options.repo}`);
    }
    this.options = options;
    this.owner = owner;
  }

  async getBranch(name: string, signal?: AbortSignal): Promise<BranchHead | null> {
    const reply = await this.request('GET', `/branches/${refPath(name)}`, {
      missing: [404],
      signal,
    });
    if (reply === null) return null;
    const { commit } = branchReply.parse(reply);
    return { commitSha: commit.sha, treeSha: commit.commit.tree.sha };
  }

  async mergeBase(base: string, head: string, signal?: AbortSignal): Promise<BranchHead> {
    const reply = await this.request('GET', `/compare/${refPath(base)}...${refPath(head)}`, {
      signal,
    });
    const { merge_base_commit: commit } = compareReply.parse(reply);
    return { commitSha: commit.sha, treeSha: commit.commit.tree.sha };
  }

  async createBlob(base64: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.request('POST', '/git/blobs', {
      body: { content: base64, encoding: 'base64' },
      signal,
    });
    return shaReply.parse(reply).sha;
  }

  async createTree(
    baseTreeSha: string,
    entries: TreeEntry[],
    signal?: AbortSignal,
  ): Promise<string> {
    const tree = entries.map(({ path, mode, sha }) => ({ path, mode, type: 'blob', sha }));
    const reply = await this.request('POST', '/git/trees', {
      body: { base_tree: baseTreeSha, tree },
      signal,
    });
    return shaReply.parse(reply).sha;
  }

  async createCommit(
    { message, treeSha, parents }: NewCommit,
    signal?: AbortSignal,
  ): Promise<string> {
    const reply = await this.request('POST', '/git/commits', {
      body: { message, tree: treeSha, parents },
      signal,
    });
    return shaReply.parse(reply).sha;
  }

  async createBranch(name: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    assertAgentBranch(name);
    await this.request('POST', '/git/refs', {
      body: { ref: `refs/heads/${name}`, sha: commitSha },
      signal,
    });
  }

  async updateBranch(name: string, commitSha: string, signal?: AbortSignal): Promise<void> {
    assertAgentBranch(name);
    await this.request('PATCH', `/git/refs/heads/${refPath(name)}`, {
      body: { sha: commitSha, force: false },
      signal,
    });
  }

  async findOpenPullRequest(head: string, signal?: AbortSignal): Promise<PullRequest | null> {
    const query = new URLSearchParams({ state: 'open', head: `${this.owner}:${head}` });
    const reply = await this.request('GET', `/pulls?${query.toString()}&per_page=1`, { signal });
    const [pr] = z.array(pullReply).parse(reply);
    return pr === undefined ? null : toPull(pr);
  }

  async createPullRequest(
    { title, body, head, base }: NewPullRequest,
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    assertAgentBranch(head);
    const reply = await this.request('POST', '/pulls', {
      body: { title, body, head, base },
      signal,
    });
    return toPull(pullReply.parse(reply));
  }

  async closePullRequest(number: number, comment: string, signal?: AbortSignal): Promise<void> {
    await this.request('POST', `/issues/${number}/comments`, { body: { body: comment }, signal });
    await this.request('PATCH', `/pulls/${number}`, { body: { state: 'closed' }, signal });
  }

  /** Resolves with the parsed body, or null for a status in `missing`. */
  private async request(
    method: string,
    path: string,
    {
      body,
      missing = [],
      signal,
    }: { body?: unknown; missing?: number[]; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const {
      token,
      repo,
      endpoint = GITHUB_API,
      timeoutMs = GITHUB_TIMEOUT_MS,
      fetch: doFetch = fetch,
    } = this.options;
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${endpoint}/repos/${repo}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
    } catch (error) {
      throw new GitHubError(`GitHub API ${method} ${path} failed: ${String(error)}`);
    }
    if (missing.includes(res.status)) return null;
    const reply: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = errorReply.safeParse(reply);
      const message = parsed.success ? `: ${parsed.data.message}` : '';
      throw new GitHubError(`GitHub API answered ${res.status}${message}`, res.status);
    }
    return reply;
  }
}
