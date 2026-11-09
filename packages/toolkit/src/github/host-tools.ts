import { posix } from 'node:path';
import type { EscalationNote } from '@page/contracts';
import { shellQuote } from '../exec/edit.ts';
import type { ExecRunner, RunResult } from '../exec/runner.ts';
import { combineOutput } from '../exec/trim.ts';
import type {
  HostToolCall,
  HostToolOutcome,
  HostTools,
  OpenPrCall,
  PushBranchCall,
} from '../exec/types.ts';
import { WORKSPACE, writePathRefusal } from '../policy/paths.ts';
import {
  AGENT_BRANCH_PREFIX,
  GitHubError,
  type BranchHead,
  type FileMode,
  type GitHub,
  type PullRequest,
  type TreeEntry,
} from './github.ts';

// The runner keeps a million characters from each end of a stream, and base64 grows a file
// by a third, so a file this size still comes back whole. Source files are far smaller.
// Reads are batched up to this many bytes per command for the same reason.
export const MAX_PUSH_FILE_BYTES = 1_000_000;
// A fix touches a handful of files. Hundreds means something went wrong, such as a build
// output that .gitignore doesn't cover.
export const MAX_PUSH_FILES = 100;
export const MAX_PR_TITLE = 256;
// Blob uploads in flight at once. GitHub asks clients not to fire many writes in parallel.
const BLOB_CONCURRENCY = 4;
// Closing a PR the run left behind happens after the run has stopped, so it gets its own clock.
const CLOSE_TIMEOUT_MS = 15_000;

// Test code can rewrite /workspace/.git/config, and `core.fsmonitor` there would make
// every `git status` run a program of its choosing. `-c` beats the repo's own config.
export const SAFE_GIT = 'git -c core.fsmonitor=false --no-optional-locks';

export interface GitHubHostToolsOptions {
  github: GitHub;
  /** The run's sandbox, where the agent's changes are. Read only. */
  workspace: ExecRunner;
  issueId: string;
  runId: string;
  /** The branch the run's branch starts from and the PR targets. */
  base?: string;
  /** The note from the tier below, when the issue was escalated to this run. */
  escalationNote?: EscalationNote;
  /** The run's stop signal. Once it fires, no further GitHub request goes out. */
  signal?: AbortSignal;
}

interface Change {
  path: string;
  /** Added (untracked), modified or deleted. */
  status: 'A' | 'M' | 'D';
}

interface FileInfo {
  path: string;
  mode: FileMode;
  size: number;
}

type Sh = (command: string) => Promise<RunResult>;

const fail = (output: string): HostToolOutcome => ({ ok: false, output });

/** What a host tool returns early with; `run` turns it into the failed outcome. */
class Refused extends Error {}

/**
 * `git.pushBranch` and `github.openPr` for one run, on the demo repo. The sandbox has no
 * network, so the push doesn't use git: the changed files are read out of the container and
 * committed through GitHub's API to `pageagents/<runId>`. Every push builds the whole change
 * again over the point the branch forked from `base`, so a file the agent put back is put
 * back on the branch too, and a `base` that moved on doesn't leak into the PR.
 *
 * The sandbox workspace is a copy of the demo repo's `base`, so a path in one is the same
 * path in the other.
 */
export class GitHubHostTools implements HostTools {
  readonly branch: string;
  /** The run's PR, once one is open. */
  pr: PullRequest | null = null;
  private readonly options: GitHubHostToolsOptions;
  private readonly base: string;

  constructor(options: GitHubHostToolsOptions) {
    this.options = options;
    this.base = options.base ?? 'main';
    this.branch = `${AGENT_BRANCH_PREFIX}${options.runId}`;
  }

  get prUrl(): string | null {
    return this.pr?.url ?? null;
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    const deadline = Date.now() + timeoutMs;
    const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
    const { signal: stopped } = this.options;
    const signal = stopped === undefined ? timeout : AbortSignal.any([timeout, stopped]);
    try {
      return call.tool === 'git.pushBranch'
        ? await this.pushBranch(call, deadline, signal)
        : await this.openPr(call, signal);
    } catch (error) {
      if (error instanceof Refused) return fail(error.message);
      // GitHub saying no, or being down, is something the agent can read and work around.
      if (error instanceof GitHubError) {
        if (stopped?.aborted) return fail(`${call.tool} stopped: the run was stopped`);
        if (timeout.aborted) return fail(`${call.tool} ran out of time after ${timeoutMs} ms`);
        return fail(`GitHub: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Closes the run's PR, if it opened one, with `comment` saying why. For a run that ended
   * without succeeding, so the tier above doesn't open a second PR next to it. Resolves
   * whether it closed one; a GitHub failure rejects.
   */
  async closePr(comment: string): Promise<boolean> {
    if (this.pr === null) return false;
    await this.options.github.closePullRequest(
      this.pr.number,
      comment,
      AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    );
    this.pr = null;
    return true;
  }

  private async pushBranch({ message }: PushBranchCall, deadline: number, signal: AbortSignal) {
    if (message.trim() === '') return fail('git.pushBranch needs a commit message');
    const sh: Sh = (command) =>
      this.options.workspace.run({ command, timeoutMs: Math.max(1, deadline - Date.now()) });

    const status = await sh(`${SAFE_GIT} status --porcelain=v1 -z --untracked-files=all`);
    if (!exitedOk(status)) return fail(`git status failed: ${describe(status)}`);
    const changes = parseStatus(status.stdout);
    if (changes.length === 0) return fail('nothing to push: no file differs from the baseline');
    if (changes.length > MAX_PUSH_FILES) {
      return fail(`${changes.length} files changed; a push takes at most ${MAX_PUSH_FILES}`);
    }
    // The same rule as the edit tool, so nothing written by a test run (CI under .github/,
    // say) reaches the demo repo even when the token would allow it.
    for (const { path } of changes) {
      const refusal = writePathRefusal(path);
      if (refusal !== null) return fail(`can't push ${path}: ${refusal}`);
    }

    const deleted = changes.filter((c) => c.status === 'D');
    const deletedModes = deleted.length === 0 ? new Map() : await trackedModes(sh, deleted);
    const files = await statFiles(
      sh,
      changes.filter((c) => c.status !== 'D').map((c) => c.path),
    );
    const contents = await readFiles(sh, files);

    const { github } = this.options;
    const existing = await github.getBranch(this.branch, signal);
    let treeBase: BranchHead;
    if (existing === null) {
      const base = await github.getBranch(this.base, signal);
      if (base === null) return fail(`the demo repo has no ${this.base} branch`);
      treeBase = base;
    } else {
      treeBase = await github.mergeBase(this.base, this.branch, signal);
    }

    const blobs = await mapLimit(contents, BLOB_CONCURRENCY, ({ base64 }) =>
      github.createBlob(base64, signal),
    );
    const entries: TreeEntry[] = [
      ...files.map(({ path, mode }, i) => ({ path, mode, sha: blobs[i] ?? null })),
      ...deleted.map(({ path }) => ({
        path,
        mode: (deletedModes.get(path) ?? '100644') as FileMode,
        sha: null,
      })),
    ];

    const treeSha = await github.createTree(treeBase.treeSha, entries, signal);
    if (existing?.treeSha === treeSha) {
      return { ok: true, output: `${this.branch} already has these changes; nothing new to push` };
    }
    const commitSha = await github.createCommit(
      { message: message.trim(), treeSha, parents: [existing?.commitSha ?? treeBase.commitSha] },
      signal,
    );
    if (existing === null) await github.createBranch(this.branch, commitSha, signal);
    else await github.updateBranch(this.branch, commitSha, signal);

    const listing = changes.map((c) => `${c.status} ${c.path}`).join('\n');
    return {
      ok: true,
      output: `pushed ${changes.length} file(s) to ${this.branch} as ${commitSha.slice(0, 7)}:\n${listing}`,
    };
  }

  private async openPr({ title, body }: OpenPrCall, signal: AbortSignal) {
    const cleanTitle = title.trim();
    if (cleanTitle === '') return fail('github.openPr needs a title');
    if (cleanTitle.length > MAX_PR_TITLE) {
      return fail(
        `the PR title is ${cleanTitle.length} characters; keep it to ${MAX_PR_TITLE} at most`,
      );
    }
    const { github } = this.options;
    if ((await github.getBranch(this.branch, signal)) === null) {
      return fail(`${this.branch} isn't on the demo repo yet; push it with git.pushBranch first`);
    }
    const open = await github.findOpenPullRequest(this.branch, signal);
    if (open !== null) {
      this.pr = open;
      return { ok: true, output: `PR #${open.number} is already open: ${open.url}` };
    }
    const pr = await github.createPullRequest(
      { title: cleanTitle, body: prBody(body, this.options), head: this.branch, base: this.base },
      signal,
    );
    this.pr = pr;
    return { ok: true, output: `opened PR #${pr.number}: ${pr.url}` };
  }
}

/** The git mode of each deleted path, as the index has it, so the deletion names the same entry. */
async function trackedModes(sh: Sh, changes: Change[]): Promise<Map<string, FileMode>> {
  const paths = changes.map((c) => shellQuote(c.path)).join(' ');
  const listed = await sh(`${SAFE_GIT} ls-files -s -z -- ${paths}`);
  if (!exitedOk(listed)) throw new Refused(`git ls-files failed: ${describe(listed)}`);
  const modes = new Map<string, FileMode>();
  for (const entry of listed.stdout.split('\0')) {
    // `<mode> <sha> <stage>\t<path>`
    const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/s.exec(entry);
    if (match === null) continue;
    const [, mode = '', path = ''] = match;
    modes.set(path, mode === '100755' || mode === '120000' ? mode : '100644');
  }
  return modes;
}

/**
 * Each file's size and mode as the working tree has them, in one command. `stat` doesn't
 * follow links, so a symlink shows up as one, tracked or not, and is refused: its bytes
 * would be the target's. The executable bit comes from the file, so a new script keeps it.
 */
async function statFiles(sh: Sh, paths: string[]): Promise<FileInfo[]> {
  if (paths.length === 0) return [];
  const quoted = paths.map((p) => shellQuote(posix.resolve(WORKSPACE, p))).join(' ');
  const listed = await sh(`stat -c '%s %a %F' -- ${quoted}`);
  if (!exitedOk(listed)) throw new Refused(`could not read the changed files: ${describe(listed)}`);
  // One line per file. The format leaves the name out, so a newline in one can't shift them.
  const lines = listed.stdout.split('\n');
  return paths.map((path, i) => {
    const match = /^(\d+) ([0-7]+) (.+)$/.exec(lines[i] ?? '');
    if (match === null) throw new Refused(`could not read the size of ${path}`);
    const [, size = '', perms = '', type = ''] = match;
    if (type === 'symbolic link')
      throw new Refused(`${path} is a symlink, which a push can't carry`);
    if (type !== 'regular file' && type !== 'regular empty file') {
      throw new Refused(`${path} is a ${type}, which a push can't carry`);
    }
    if (Number(size) > MAX_PUSH_FILE_BYTES) {
      throw new Refused(
        `${path} is ${size} bytes; a push takes files up to ${MAX_PUSH_FILE_BYTES}`,
      );
    }
    const executable = (parseInt(perms, 8) & 0o100) !== 0;
    return { path, mode: executable ? '100755' : '100644', size: Number(size) };
  });
}

/**
 * The files' bytes as base64, a batch per command, each checked against its size so a
 * cut-off read can't be pushed. A `.` line ends each file; base64 never prints one.
 */
async function readFiles(sh: Sh, files: FileInfo[]): Promise<{ base64: string }[]> {
  const out: { base64: string }[] = [];
  for (const batch of batches(files)) {
    const command = batch
      .map(({ path }) => `base64 ${shellQuote(posix.resolve(WORKSPACE, path))} && echo .`)
      .join(' && ');
    const read = await sh(command);
    if (!exitedOk(read)) {
      throw new Refused(`could not read ${batch.map((f) => f.path).join(', ')}: ${describe(read)}`);
    }
    const chunks = read.stdout.split(/^\.$/m);
    batch.forEach(({ path, size }, i) => {
      const base64 = (chunks[i] ?? '').replace(/\s/g, '');
      if (Buffer.from(base64, 'base64').length !== size) {
        throw new Refused(`${path} came back cut short; try the push again`);
      }
      out.push({ base64 });
    });
  }
  return out;
}

/** Splits `files` into runs whose sizes add up to MAX_PUSH_FILE_BYTES at most. */
function batches(files: FileInfo[]): FileInfo[][] {
  const out: FileInfo[][] = [];
  let current: FileInfo[] = [];
  let bytes = 0;
  for (const file of files) {
    if (current.length > 0 && bytes + file.size > MAX_PUSH_FILE_BYTES) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** `fn` over `items` with at most `limit` in flight, results in order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function exitedOk(result: RunResult): result is RunResult & { status: 'exited' } {
  return result.status === 'exited' && result.exitCode === 0;
}

function describe(result: RunResult): string {
  const output = combineOutput(result.stdout, result.stderr).trim();
  if (result.status === 'timed_out') return 'timed out';
  return output === '' ? `exit ${result.exitCode}` : output;
}

/**
 * Reads `git status -z` output. The agent can't stage anything, so every change is in the
 * working tree: modified, deleted, or untracked. A staged rename or copy carries a second
 * path, which is skipped.
 */
export function parseStatus(stdout: string): Change[] {
  const fields = stdout.split('\0');
  const changes: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1;
    const status = code.includes('D') ? 'D' : code === '??' ? 'A' : 'M';
    changes.push({ path, status });
  }
  return changes;
}

/** The agent's description, then where the PR came from and why the tier below gave up. */
export function prBody(
  body: string,
  {
    issueId,
    runId,
    escalationNote,
  }: Pick<GitHubHostToolsOptions, 'issueId' | 'runId' | 'escalationNote'>,
): string {
  const parts = [body.trim() === '' ? '_No description from the agent._' : body.trim()];
  parts.push(`---\n\nOpened by PageAgents for issue \`${issueId}\`, run \`${runId}\`.`);
  if (escalationNote !== undefined) {
    const { summary, tried, blocker } = escalationNote;
    const lines = [
      '### Escalation note from the tier below',
      '',
      summary,
      '',
      `**Blocker:** ${blocker}`,
    ];
    if (tried.length > 0) lines.push('', '**Tried:**', '', '```', ...tried, '```');
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}
