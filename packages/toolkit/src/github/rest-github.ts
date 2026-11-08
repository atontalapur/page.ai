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

  async getBranch(name: string): Promise<BranchHead | null> {
    const reply = await this.request('GET', `/branches/${refPath(name)}`, undefined, [404]);
    if (reply === null) return null;
    const { commit } = branchReply.parse(reply);
    return { commitSha: commit.sha, treeSha: commit.commit.tree.sha };
  }

  async createBlob(base64: string): Promise<string> {
    const reply = await this.request('POST', '/git/blobs', { content: base64, encoding: 'base64' });
    return shaReply.parse(reply).sha;
  }

  async createTree(baseTreeSha: string, entries: TreeEntry[]): Promise<string> {
    const tree = entries.map(({ path, mode, sha }) => ({ path, mode, type: 'blob', sha }));
    const reply = await this.request('POST', '/git/trees', { base_tree: baseTreeSha, tree });
    return shaReply.parse(reply).sha;
  }

  async createCommit({ message, treeSha, parents }: NewCommit): Promise<string> {
    const reply = await this.request('POST', '/git/commits', { message, tree: treeSha, parents });
    return shaReply.parse(reply).sha;
  }

  async createBranch(name: string, commitSha: string): Promise<void> {
    assertAgentBranch(name);
    await this.request('POST', '/git/refs', { ref: `refs/heads/${name}`, sha: commitSha });
  }

  async updateBranch(name: string, commitSha: string): Promise<void> {
    assertAgentBranch(name);
    await this.request('PATCH', `/git/refs/heads/${refPath(name)}`, {
      sha: commitSha,
      force: false,
    });
  }

  async findOpenPullRequest(head: string): Promise<PullRequest | null> {
    const query = new URLSearchParams({ state: 'open', head: `${this.owner}:${head}` });
    const reply = await this.request('GET', `/pulls?${query.toString()}&per_page=1`);
    const [pr] = z.array(pullReply).parse(reply);
    return pr === undefined ? null : toPull(pr);
  }

  async createPullRequest({ title, body, head, base }: NewPullRequest): Promise<PullRequest> {
    assertAgentBranch(head);
    const reply = await this.request('POST', '/pulls', { title, body, head, base });
    return toPull(pullReply.parse(reply));
  }

  /** Resolves with the parsed body, or null for a status in `missing`. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    missing: number[] = [],
  ): Promise<unknown> {
    const {
      token,
      repo,
      endpoint = GITHUB_API,
      timeoutMs = GITHUB_TIMEOUT_MS,
      fetch: doFetch = fetch,
    } = this.options;
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
        signal: AbortSignal.timeout(timeoutMs),
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
