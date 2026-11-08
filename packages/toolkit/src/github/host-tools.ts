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
import { WORKSPACE } from '../policy/paths.ts';
import { AGENT_BRANCH_PREFIX, GitHubError, type FileMode, type GitHub } from './github.ts';

// The runner keeps a million characters from each end of a stream, and base64 grows a file
// by a third, so a file this size still comes back whole. Source files are far smaller.
export const MAX_PUSH_FILE_BYTES = 1_000_000;
// A fix touches a handful of files. Hundreds means something went wrong, such as a build
// output that .gitignore doesn't cover.
export const MAX_PUSH_FILES = 100;
export const MAX_PR_TITLE = 256;

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
}

interface Change {
  path: string;
  deleted: boolean;
}

const fail = (output: string): HostToolOutcome => ({ ok: false, output });

/**
 * `git.pushBranch` and `github.openPr` for one run, on the demo repo. The sandbox has no
 * network, so the push doesn't use git: the changed files are read out of the container and
 * committed through GitHub's API to `pageagents/<runId>`, over `base`. Every push builds the
 * whole change again over `base`, so a file the agent put back is put back on the branch too.
 *
 * The sandbox workspace is a copy of the demo repo's `base`, so a path in one is the same
 * path in the other.
 */
export class GitHubHostTools implements HostTools {
  readonly branch: string;
  /** The run's PR, once one is open. */
  prUrl: string | null = null;
  private readonly options: GitHubHostToolsOptions;
  private readonly base: string;

  constructor(options: GitHubHostToolsOptions) {
    this.options = options;
    this.base = options.base ?? 'main';
    this.branch = `${AGENT_BRANCH_PREFIX}${options.runId}`;
  }

  async run(call: HostToolCall, timeoutMs: number): Promise<HostToolOutcome> {
    try {
      return call.tool === 'git.pushBranch'
        ? await this.pushBranch(call, timeoutMs)
        : await this.openPr(call);
    } catch (error) {
      // GitHub saying no, or being down, is something the agent can read and work around.
      if (error instanceof GitHubError) return fail(`GitHub: ${error.message}`);
      throw error;
    }
  }

  private async pushBranch({ message }: PushBranchCall, timeoutMs: number) {
    if (message.trim() === '') return fail('git.pushBranch needs a commit message');
    const deadline = Date.now() + timeoutMs;
    const sh = (command: string) =>
      this.options.workspace.run({ command, timeoutMs: Math.max(1, deadline - Date.now()) });

    const status = await sh('git status --porcelain=v1 -z --untracked-files=all');
    if (!exitedOk(status)) return fail(`git status failed: ${describe(status)}`);
    const changes = parseStatus(status.stdout);
    if (changes.length === 0) return fail('nothing to push: no file differs from the baseline');
    if (changes.length > MAX_PUSH_FILES) {
      return fail(`${changes.length} files changed; a push takes at most ${MAX_PUSH_FILES}`);
    }

    const modes = await this.trackedModes(sh, changes);
    if (typeof modes === 'string') return fail(modes);

    const { github } = this.options;
    const base = await github.getBranch(this.base);
    if (base === null) return fail(`the demo repo has no ${this.base} branch`);

    const entries = [];
    for (const change of changes) {
      const mode = modes.get(change.path) ?? '100644';
      if (mode === '120000') return fail(`${change.path} is a symlink, which a push can't carry`);
      if (change.deleted) {
        entries.push({ path: change.path, mode, sha: null });
        continue;
      }
      const content = await readBase64(sh, change.path);
      if (typeof content === 'string') {
        entries.push({ path: change.path, mode, sha: await github.createBlob(content) });
      } else {
        return fail(content.problem);
      }
    }

    const treeSha = await github.createTree(base.treeSha, entries);
    const existing = await github.getBranch(this.branch);
    if (existing?.treeSha === treeSha) {
      return { ok: true, output: `${this.branch} already has these changes; nothing new to push` };
    }
    const commitSha = await github.createCommit({
      message: message.trim(),
      treeSha,
      parents: [existing?.commitSha ?? base.commitSha],
    });
    if (existing === null) await github.createBranch(this.branch, commitSha);
    else await github.updateBranch(this.branch, commitSha);

    const listing = changes.map((c) => `${c.deleted ? 'D' : 'M'} ${c.path}`).join('\n');
    return {
      ok: true,
      output: `pushed ${changes.length} file(s) to ${this.branch} as ${commitSha.slice(0, 7)}:\n${listing}`,
    };
  }

  private async openPr({ title, body }: OpenPrCall) {
    const cleanTitle = title.trim();
    if (cleanTitle === '') return fail('github.openPr needs a title');
    if (cleanTitle.length > MAX_PR_TITLE) {
      return fail(`the PR title is ${cleanTitle.length} characters; keep it under ${MAX_PR_TITLE}`);
    }
    const { github } = this.options;
    if ((await github.getBranch(this.branch)) === null) {
      return fail(`${this.branch} isn't on the demo repo yet; push it with git.pushBranch first`);
    }
    const open = await github.findOpenPullRequest(this.branch);
    if (open !== null) {
      this.prUrl = open.url;
      return { ok: true, output: `PR #${open.number} is already open: ${open.url}` };
    }
    const pr = await github.createPullRequest({
      title: cleanTitle,
      body: prBody(body, this.options),
      head: this.branch,
      base: this.base,
    });
    this.prUrl = pr.url;
    return { ok: true, output: `opened PR #${pr.number}: ${pr.url}` };
  }

  /** The git mode of each changed path that git already tracks, or why it couldn't be read. */
  private async trackedModes(
    sh: (command: string) => Promise<RunResult>,
    changes: Change[],
  ): Promise<Map<string, FileMode> | string> {
    const paths = changes.map((c) => shellQuote(c.path)).join(' ');
    const listed = await sh(`git ls-files -s -z -- ${paths}`);
    if (!exitedOk(listed)) return `git ls-files failed: ${describe(listed)}`;
    const modes = new Map<string, FileMode>();
    for (const entry of listed.stdout.split('\0')) {
      // `<mode> <sha> <stage>\t<path>`
      const match = /^(\d{6}) [0-9a-f]+ \d\t(.+)$/s.exec(entry);
      if (match === null) continue;
      const [, mode, path] = match;
      if (mode === '100755' || mode === '120000') modes.set(path!, mode);
      else modes.set(path!, '100644');
    }
    return modes;
  }
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
    changes.push({ path, deleted: code.includes('D') });
  }
  return changes;
}

/** The file's bytes as base64, checked against its size so a cut-off read can't be pushed. */
async function readBase64(
  sh: (command: string) => Promise<RunResult>,
  path: string,
): Promise<string | { problem: string }> {
  const absolute = shellQuote(posix.resolve(WORKSPACE, path));
  const read = await sh(`stat -c %s ${absolute} && base64 ${absolute}`);
  if (!exitedOk(read)) return { problem: `could not read ${path}: ${describe(read)}` };
  const [sizeLine = '', ...rest] = read.stdout.split('\n');
  const size = Number(sizeLine);
  if (!Number.isInteger(size)) return { problem: `could not read the size of ${path}` };
  if (size > MAX_PUSH_FILE_BYTES) {
    return { problem: `${path} is ${size} bytes; a push takes files up to ${MAX_PUSH_FILE_BYTES}` };
  }
  const content = rest.join('').replace(/\s/g, '');
  if (Buffer.from(content, 'base64').length !== size) {
    return { problem: `${path} came back cut short; try the push again` };
  }
  return content;
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
