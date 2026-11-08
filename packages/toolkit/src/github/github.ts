// The port the Tier 2 host tools go through. RestGitHub talks to GitHub's REST API with the
// bot account's token, which can write only the demo repo; FakeGitHub stands in for it in tests. The
// token lives in the daemon, never in the sandbox, which has no network anyway.

/**
 * The only branches the host tools write. The demo repo's ruleset holds every other branch
 * to the same rule, so this check is a second line, not the only one.
 */
export const AGENT_BRANCH_PREFIX = 'pageagents/';

/** A branch's head commit and that commit's tree. */
export interface BranchHead {
  commitSha: string;
  treeSha: string;
}

/** Regular file, executable file, or symlink, as git records them. */
export type FileMode = '100644' | '100755' | '120000';

/** One path in a new tree. `sha` is a blob from createBlob, or null to delete the path. */
export interface TreeEntry {
  path: string;
  mode: FileMode;
  sha: string | null;
}

export interface PullRequest {
  number: number;
  /** The PR's page on github.com. */
  url: string;
}

export interface NewCommit {
  message: string;
  treeSha: string;
  parents: string[];
}

export interface NewPullRequest {
  title: string;
  body: string;
  head: string;
  base: string;
}

/**
 * One repository's git data and pull requests. Every method rejects when the request fails;
 * `getBranch` and `findOpenPullRequest` resolve null for something that isn't there.
 * Methods that write a branch reject for a name outside AGENT_BRANCH_PREFIX.
 */
export interface GitHub {
  getBranch(name: string): Promise<BranchHead | null>;
  /** Stores file content, given as base64, and resolves with the blob's sha. */
  createBlob(base64: string): Promise<string>;
  /** `baseTreeSha`'s tree with `entries` written over it. Resolves with the new tree's sha. */
  createTree(baseTreeSha: string, entries: TreeEntry[]): Promise<string>;
  createCommit(commit: NewCommit): Promise<string>;
  createBranch(name: string, commitSha: string): Promise<void>;
  /** Moves the branch to `commitSha`. Never forced, so it must be a fast-forward. */
  updateBranch(name: string, commitSha: string): Promise<void>;
  /** The open PR from `head`, if there is one. */
  findOpenPullRequest(head: string): Promise<PullRequest | null>;
  createPullRequest(pr: NewPullRequest): Promise<PullRequest>;
}

/** A request GitHub answered with an error, or one that broke on the way. */
export class GitHubError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

/** Throws unless `name` is a branch the host tools may write. */
export function assertAgentBranch(name: string): void {
  const rest = name.slice(AGENT_BRANCH_PREFIX.length);
  if (!name.startsWith(AGENT_BRANCH_PREFIX) || rest === '' || rest.includes('..')) {
    throw new GitHubError(`${name} is not a ${AGENT_BRANCH_PREFIX}* branch`);
  }
}
