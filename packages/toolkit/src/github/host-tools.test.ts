import { describe, expect, it } from 'vitest';
import { FakeRunner } from '../exec/fake-runner.ts';
import type { RunRequest, RunResult } from '../exec/runner.ts';
import { FakeGitHub } from './fake-github.ts';
import { GitHubError } from './github.ts';
import {
  GitHubHostTools,
  MAX_PR_TITLE,
  MAX_PUSH_FILE_BYTES,
  MAX_PUSH_FILES,
  parseStatus,
  prBody,
} from './host-tools.ts';

const ISSUE = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-000000000002';
const BRANCH = `pageagents/${RUN}`;

const MAIN = {
  'apps/demo-app/lib/money.ts': 'export const cents = 1;\n',
  'apps/demo-app/lib/old.ts': 'old\n',
  'apps/demo-app/run.sh': '#!/bin/sh\n',
};

/**
 * A sandbox workspace as the host tools see it: `status` is what `git status -z` prints,
 * `files` the working tree contents, `modes` what `git ls-files -s -z` prints. Any of them
 * can be swapped mid-test.
 */
class Workspace {
  status = '';
  files: Record<string, string> = {};
  modes = '';
  override: ((request: RunRequest) => RunResult | undefined) | null = null;
  readonly runner = new FakeRunner((request) => this.answer(request));

  private answer(request: RunRequest): RunResult {
    const overridden = this.override?.(request);
    if (overridden !== undefined) return overridden;
    const { command } = request;
    if (command.startsWith('git status')) return FakeRunner.exited(0, this.status);
    if (command.startsWith('git ls-files')) return FakeRunner.exited(0, this.modes);
    const path = /^stat -c %s '\/workspace\/([^']+)'/.exec(command)?.[1];
    if (path !== undefined) {
      const text = this.files[path];
      if (text === undefined) return FakeRunner.exited(1, '', `stat: ${path}: not found`);
      const base64 = Buffer.from(text).toString('base64');
      // busybox wraps base64 at 76 columns.
      const wrapped = base64.match(/.{1,76}/g)?.join('\n') ?? '';
      return FakeRunner.exited(0, `${Buffer.byteLength(text)}\n${wrapped}\n`);
    }
    return FakeRunner.exited(127, '', `unexpected command: ${command}`);
  }
}

const status = (...entries: string[]) => entries.map((e) => `${e}\0`).join('');
const mode = (m: string, path: string) => `${m} ${'a'.repeat(40)} 0\t${path}\0`;

function setup(options: { escalation?: boolean } = {}) {
  const github = new FakeGitHub(MAIN);
  const workspace = new Workspace();
  const tools = new GitHubHostTools({
    github,
    workspace: workspace.runner,
    issueId: ISSUE,
    runId: RUN,
    ...(options.escalation
      ? {
          escalationNote: {
            summary: 'Tier 1 ran out of steps.',
            tried: ['pnpm --filter @page/demo-app test', 'cat lib/money.ts'],
            blocker: 'step limit',
          },
        }
      : {}),
  });
  return { github, workspace, tools };
}

const push = (tools: GitHubHostTools, message = 'fix: round cents') =>
  tools.run({ kind: 'host_tool', tool: 'git.pushBranch', message }, 30_000);

const openPr = (tools: GitHubHostTools, title = 'fix: round cents', body = 'Rounds cents.') =>
  tools.run({ kind: 'host_tool', tool: 'github.openPr', title, body }, 30_000);

describe('GitHubHostTools git.pushBranch', () => {
  it('commits modified, new and deleted files to the run branch over main', async () => {
    const { github, workspace, tools } = setup();
    workspace.status = status(
      ' M apps/demo-app/lib/money.ts',
      '?? apps/demo-app/lib/new.ts',
      ' D apps/demo-app/lib/old.ts',
      ' M apps/demo-app/run.sh',
    );
    workspace.modes = [
      mode('100644', 'apps/demo-app/lib/money.ts'),
      mode('100644', 'apps/demo-app/lib/old.ts'),
      mode('100755', 'apps/demo-app/run.sh'),
    ].join('');
    workspace.files = {
      'apps/demo-app/lib/money.ts': 'export const cents = 100;\n',
      'apps/demo-app/lib/new.ts': 'new\n'.repeat(40),
      'apps/demo-app/run.sh': '#!/bin/sh\nexit 0\n',
    };

    const result = await push(tools);

    expect(result.ok).toBe(true);
    expect(result.output).toMatch(new RegExp(`^pushed 4 file\\(s\\) to ${BRANCH} as [0-9a-f]{7}:`));
    expect(result.output).toContain('D apps/demo-app/lib/old.ts');
    expect(result.output).toContain('A apps/demo-app/lib/new.ts');
    expect(github.files(BRANCH)).toEqual({
      'apps/demo-app/lib/money.ts': { mode: '100644', text: 'export const cents = 100;\n' },
      'apps/demo-app/lib/new.ts': { mode: '100644', text: 'new\n'.repeat(40) },
      'apps/demo-app/run.sh': { mode: '100755', text: '#!/bin/sh\nexit 0\n' },
    });
    const head = github.head(BRANCH)!;
    expect(github.commitInfo(head)).toEqual({
      message: 'fix: round cents',
      parents: [github.head('main')],
    });
    // main is untouched.
    expect(github.files('main')['apps/demo-app/lib/money.ts']!.text).toBe(
      MAIN['apps/demo-app/lib/money.ts'],
    );
    // Paths are quoted and read from the workspace, never passed as bare words.
    expect(workspace.runner.requests.map((r) => r.command)).toContain(
      "stat -c %s '/workspace/apps/demo-app/lib/money.ts' && base64 '/workspace/apps/demo-app/lib/money.ts'",
    );
  });

  it('fast-forwards the branch on a second push, putting back files the agent reverted', async () => {
    const { github, workspace, tools } = setup();
    workspace.status = status(' M apps/demo-app/lib/money.ts', '?? apps/demo-app/lib/new.ts');
    workspace.files = {
      'apps/demo-app/lib/money.ts': 'export const cents = 100;\n',
      'apps/demo-app/lib/new.ts': 'new\n',
    };
    await push(tools, 'first');
    const first = github.head(BRANCH)!;

    workspace.status = status(' M apps/demo-app/lib/money.ts');
    workspace.files = { 'apps/demo-app/lib/money.ts': 'export const cents = 99;\n' };
    const result = await push(tools, 'second');

    expect(result.ok).toBe(true);
    expect(github.commitInfo(github.head(BRANCH)!)).toEqual({
      message: 'second',
      parents: [first],
    });
    expect(github.files(BRANCH)).not.toHaveProperty(['apps/demo-app/lib/new.ts']);
    expect(github.files(BRANCH)['apps/demo-app/lib/money.ts']!.text).toBe(
      'export const cents = 99;\n',
    );
  });

  it('pushes nothing new when the branch already holds the same tree', async () => {
    const { github, workspace, tools } = setup();
    workspace.status = status(' M apps/demo-app/lib/money.ts');
    workspace.files = { 'apps/demo-app/lib/money.ts': 'x\n' };
    await push(tools);
    const head = github.head(BRANCH);

    expect(await push(tools)).toEqual({
      ok: true,
      output: `${BRANCH} already has these changes; nothing new to push`,
    });
    expect(github.head(BRANCH)).toBe(head);
  });

  it('refuses a push with no changes or no message', async () => {
    const { workspace, tools } = setup();
    expect(await push(tools)).toEqual({
      ok: false,
      output: 'nothing to push: no file differs from the baseline',
    });
    workspace.status = status(' M a.ts');
    expect(await push(tools, '  ')).toEqual({
      ok: false,
      output: 'git.pushBranch needs a commit message',
    });
    expect(workspace.runner.requests).toHaveLength(1);
  });

  it(`refuses more than ${MAX_PUSH_FILES} changed files`, async () => {
    const { workspace, tools } = setup();
    workspace.status = status(...Array.from({ length: MAX_PUSH_FILES + 1 }, (_, i) => `?? f${i}`));
    expect(await push(tools)).toEqual({
      ok: false,
      output: `${MAX_PUSH_FILES + 1} files changed; a push takes at most ${MAX_PUSH_FILES}`,
    });
  });

  it('refuses a symlink', async () => {
    const { workspace, tools } = setup();
    workspace.status = status(' M link');
    workspace.modes = mode('120000', 'link');
    expect(await push(tools)).toEqual({
      ok: false,
      output: "link is a symlink, which a push can't carry",
    });
  });

  it('refuses a file over the size cap, and one that came back cut short', async () => {
    const { workspace, tools } = setup();
    workspace.status = status('?? big.bin');
    workspace.override = ({ command }) =>
      command.startsWith('stat') ? FakeRunner.exited(0, `${MAX_PUSH_FILE_BYTES + 1}\n`) : undefined;
    expect((await push(tools)).output).toBe(
      `big.bin is ${MAX_PUSH_FILE_BYTES + 1} bytes; a push takes files up to ${MAX_PUSH_FILE_BYTES}`,
    );

    workspace.override = ({ command }) =>
      command.startsWith('stat') ? FakeRunner.exited(0, '10\naGk=\n') : undefined;
    expect((await push(tools)).output).toBe('big.bin came back cut short; try the push again');

    workspace.override = ({ command }) =>
      command.startsWith('stat') ? FakeRunner.exited(0, 'nope\n') : undefined;
    expect((await push(tools)).output).toBe('could not read the size of big.bin');
  });

  it('reports a workspace command that fails or times out', async () => {
    const { workspace, tools } = setup();
    workspace.override = ({ command }) =>
      command.startsWith('git status') ? FakeRunner.exited(128, '', 'not a git repo') : undefined;
    expect(await push(tools)).toEqual({
      ok: false,
      output: 'git status failed: [stderr]\nnot a git repo',
    });

    workspace.override = ({ command }) =>
      command.startsWith('git status') ? FakeRunner.exited(1) : undefined;
    expect((await push(tools)).output).toBe('git status failed: exit 1');

    workspace.status = status(' M a.ts');
    workspace.override = ({ command }) =>
      command.startsWith('git ls-files') ? FakeRunner.timedOut() : undefined;
    expect((await push(tools)).output).toBe('git ls-files failed: timed out');

    workspace.override = null;
    expect((await push(tools)).output).toBe('could not read a.ts: [stderr]\nstat: a.ts: not found');
  });

  it('gives each workspace command what is left of the deadline', async () => {
    const { workspace, tools } = setup();
    workspace.status = status(' M apps/demo-app/lib/money.ts');
    workspace.files = { 'apps/demo-app/lib/money.ts': 'x\n' };
    await push(tools);
    for (const request of workspace.runner.requests) {
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.timeoutMs).toBeLessThanOrEqual(30_000);
    }
  });

  it('fails when the demo repo has no base branch', async () => {
    const github = new FakeGitHub();
    const workspace = new Workspace();
    workspace.status = status(' M a.ts');
    const tools = new GitHubHostTools({
      github,
      workspace: workspace.runner,
      issueId: ISSUE,
      runId: RUN,
      base: 'trunk',
    });
    expect(await push(tools)).toEqual({ ok: false, output: 'the demo repo has no trunk branch' });
  });

  it('turns a GitHub error into a failure the agent reads', async () => {
    const { github, workspace, tools } = setup();
    workspace.status = status(' M apps/demo-app/lib/money.ts');
    workspace.files = { 'apps/demo-app/lib/money.ts': 'x\n' };
    github.failOn.add('createBlob');
    expect(await push(tools)).toEqual({
      ok: false,
      output: 'GitHub: GitHub API answered 503: unavailable',
    });
  });

  it('lets anything other than a GitHub error through', async () => {
    const { github, workspace, tools } = setup();
    workspace.status = status(' M apps/demo-app/lib/money.ts');
    workspace.files = { 'apps/demo-app/lib/money.ts': 'x\n' };
    github.createBlob = () => Promise.reject(new TypeError('bug'));
    await expect(push(tools)).rejects.toThrow(TypeError);
  });
});

describe('GitHubHostTools github.openPr', () => {
  async function pushed(options: { escalation?: boolean } = {}) {
    const s = setup(options);
    s.workspace.status = status(' M apps/demo-app/lib/money.ts');
    s.workspace.files = { 'apps/demo-app/lib/money.ts': 'x\n' };
    await push(s.tools);
    return s;
  }

  it('wants the branch pushed first', async () => {
    const { tools } = setup();
    expect(await openPr(tools)).toEqual({
      ok: false,
      output: `${BRANCH} isn't on the demo repo yet; push it with git.pushBranch first`,
    });
    expect(tools.prUrl).toBeNull();
  });

  it('opens a PR from the run branch to main, linking the issue and run', async () => {
    const { github, tools } = await pushed();
    const result = await openPr(tools);

    expect(result).toEqual({
      ok: true,
      output: 'opened PR #1: https://github.com/page-demo/shop/pull/1',
    });
    expect(tools.prUrl).toBe('https://github.com/page-demo/shop/pull/1');
    expect(github.pullRequests[0]).toMatchObject({
      title: 'fix: round cents',
      head: BRANCH,
      base: 'main',
      body: `Rounds cents.\n\n---\n\nOpened by PageAgents for issue \`${ISSUE}\`, run \`${RUN}\`.`,
    });
  });

  it('puts the escalation note from the tier below in the body', async () => {
    const { github, tools } = await pushed({ escalation: true });
    await openPr(tools);
    const { body } = github.pullRequests[0]!;
    expect(body).toContain('### Escalation note from the tier below\n\nTier 1 ran out of steps.');
    expect(body).toContain('**Blocker:** step limit');
    expect(body).toContain('```\npnpm --filter @page/demo-app test\ncat lib/money.ts\n```');
  });

  it('answers with the open PR instead of opening a second', async () => {
    const { github, tools } = await pushed();
    await openPr(tools);
    tools.prUrl = null;
    expect(await openPr(tools, 'again')).toEqual({
      ok: true,
      output: 'PR #1 is already open: https://github.com/page-demo/shop/pull/1',
    });
    expect(tools.prUrl).toBe('https://github.com/page-demo/shop/pull/1');
    expect(github.pullRequests).toHaveLength(1);
  });

  it('refuses an empty or overlong title', async () => {
    const { tools } = await pushed();
    expect(await openPr(tools, ' ')).toEqual({ ok: false, output: 'github.openPr needs a title' });
    const long = 'x'.repeat(MAX_PR_TITLE + 1);
    expect((await openPr(tools, long)).output).toBe(
      `the PR title is ${MAX_PR_TITLE + 1} characters; keep it under ${MAX_PR_TITLE}`,
    );
  });

  it('reports GitHub refusing the PR', async () => {
    const { github, tools } = await pushed();
    github.createPullRequest = () =>
      Promise.reject(new GitHubError('GitHub API answered 403', 403));
    expect(await openPr(tools)).toEqual({ ok: false, output: 'GitHub: GitHub API answered 403' });
  });
});

describe('parseStatus', () => {
  it('reads modified, deleted and untracked paths, and skips a rename source', () => {
    expect(
      parseStatus(
        status(' M a b.ts', ' D gone.ts', '?? new/c.ts', 'R  to.ts', 'from.ts', 'MD x.ts'),
      ),
    ).toEqual([
      { path: 'a b.ts', status: 'M' },
      { path: 'gone.ts', status: 'D' },
      { path: 'new/c.ts', status: 'A' },
      { path: 'to.ts', status: 'M' },
      { path: 'x.ts', status: 'D' },
    ]);
    expect(parseStatus('')).toEqual([]);
  });
});

describe('prBody', () => {
  it('stands in for an empty description, and leaves out an empty tried list', () => {
    const body = prBody('  ', {
      issueId: ISSUE,
      runId: RUN,
      escalationNote: { summary: 's', tried: [], blocker: 'b' },
    });
    expect(body.startsWith('_No description from the agent._\n\n---')).toBe(true);
    expect(body).not.toContain('**Tried:**');
  });
});
