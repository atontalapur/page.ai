import { z } from 'zod';

/** The few demo-repo calls the orchestrator makes when a reviewer acts on a fix's PR. */
export interface GitHubApi {
  /** The inline comments of one review, oldest first. */
  reviewComments(pr: number, reviewId: number): Promise<ReviewComment[]>;
  /** The PR's conversation comments, oldest first. */
  issueComments(pr: number): Promise<IssueComment[]>;
  /** Comments on the PR, then closes it. */
  close(pr: number, comment: string): Promise<void>;
  /** The commit a branch points at on the remote. */
  head(branch: string): Promise<string>;
  /** Every file in a commit's tree, with its blob. */
  files(commitSha: string): Promise<{ path: string; sha: string; size: number }[]>;
  /** A blob's text. */
  text(blobSha: string): Promise<string>;
  /** A PR's branch, for a comment event, whose payload names only the PR's number. */
  headRef(pr: number): Promise<string>;
  /** Posts to the PR's conversation. */
  comment(pr: number, body: string): Promise<void>;
  /** Replies in the thread of an inline review comment. */
  replyToReviewComment(pr: number, commentId: number, body: string): Promise<void>;
  /**
   * Opens a PR from a new branch off main that makes `edits`, each a list of exact text
   * swaps in one file. Returns the PR's URL. Throws when a swap's text isn't in the file.
   */
  plantPr(change: PlantChange): Promise<string>;
}

export interface PlantChange {
  branch: string;
  title: string;
  body: string;
  edits: readonly { path: string; pairs: readonly (readonly [string, string])[] }[];
}

export interface ReviewComment {
  author: string;
  path: string;
  line: number | null;
  body: string;
}

export interface IssueComment {
  author: string;
  body: string;
}

const reviewCommentsSchema = z.array(
  z.object({
    user: z.object({ login: z.string() }).nullable(),
    path: z.string(),
    line: z.number().nullable().optional(),
    original_line: z.number().nullable().optional(),
    body: z.string(),
  }),
);

const issueCommentsSchema = z.array(
  z.object({ user: z.object({ login: z.string() }).nullable(), body: z.string().nullable() }),
);

const TIMEOUT_MS = 15_000;

/**
 * GitHub's REST API with a token that can read and close the demo repo's PRs: a fixed one,
 * or a function asked before each request, for a GitHub App's installation token.
 */
export class RestGitHubApi implements GitHubApi {
  constructor(
    private readonly token: string | (() => Promise<string>),
    private readonly repo: string,
  ) {}

  async headRef(pr: number): Promise<string> {
    const body = z
      .object({ head: z.object({ ref: z.string() }) })
      .parse(await this.request('GET', `/pulls/${pr}`));
    return body.head.ref;
  }

  async reviewComments(pr: number, reviewId: number): Promise<ReviewComment[]> {
    const rows = reviewCommentsSchema.parse(
      await this.request('GET', `/pulls/${pr}/reviews/${reviewId}/comments?per_page=100`),
    );
    return rows.map((c) => ({
      author: c.user?.login ?? 'ghost',
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      body: c.body,
    }));
  }

  async issueComments(pr: number): Promise<IssueComment[]> {
    const rows = issueCommentsSchema.parse(
      await this.request('GET', `/issues/${pr}/comments?per_page=100`),
    );
    return rows.map((c) => ({ author: c.user?.login ?? 'ghost', body: c.body ?? '' }));
  }

  async plantPr({ branch, title, body, edits }: PlantChange): Promise<string> {
    const head = await this.head('main');
    await this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: head });
    for (const { path, pairs } of edits) {
      const file = z
        .object({ sha: z.string(), content: z.string() })
        .parse(await this.request('GET', `/contents/${path}?ref=${encodeURIComponent(branch)}`));
      let text = Buffer.from(file.content, 'base64').toString('utf8');
      for (const [from, to] of pairs) {
        if (!text.includes(from))
          throw new Error(`${path} no longer has the text the test bug changes`);
        text = text.replace(from, to);
      }
      await this.request('PUT', `/contents/${path}`, {
        message: `${title}: ${path.split('/').pop()}`,
        content: Buffer.from(text).toString('base64'),
        sha: file.sha,
        branch,
      });
    }
    const pr = z
      .object({ html_url: z.string() })
      .parse(await this.request('POST', '/pulls', { title, body, head: branch, base: 'main' }));
    return pr.html_url;
  }

  async comment(pr: number, body: string): Promise<void> {
    await this.request('POST', `/issues/${pr}/comments`, { body });
  }

  async replyToReviewComment(pr: number, commentId: number, body: string): Promise<void> {
    await this.request('POST', `/pulls/${pr}/comments/${commentId}/replies`, { body });
  }

  async close(pr: number, comment: string): Promise<void> {
    await this.request('POST', `/issues/${pr}/comments`, { body: comment });
    await this.request('PATCH', `/pulls/${pr}`, { state: 'closed' });
  }

  async head(branch: string): Promise<string> {
    const body = z
      .object({ object: z.object({ sha: z.string() }) })
      .parse(await this.request('GET', `/git/ref/heads/${encodeURIComponent(branch)}`));
    return body.object.sha;
  }

  async files(commitSha: string): Promise<{ path: string; sha: string; size: number }[]> {
    const body = z
      .object({
        tree: z.array(
          z.object({
            path: z.string(),
            type: z.string(),
            sha: z.string(),
            size: z.number().optional(),
          }),
        ),
      })
      .parse(await this.request('GET', `/git/trees/${commitSha}?recursive=1`));
    return body.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
  }

  async text(blobSha: string): Promise<string> {
    const body = z
      .object({ content: z.string(), encoding: z.string() })
      .parse(await this.request('GET', `/git/blobs/${blobSha}`));
    return body.encoding === 'base64'
      ? Buffer.from(body.content, 'base64').toString('utf8')
      : body.content;
  }

  private async request(method: string, path: string, body?: object): Promise<unknown> {
    const token = typeof this.token === 'string' ? this.token : await this.token();
    const res = await fetch(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub ${method} ${path} answered ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? undefined : res.json();
  }
}
