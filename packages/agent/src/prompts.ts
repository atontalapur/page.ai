import type { ExecErr, ExecOk, Result } from '@page/toolkit';
import { ACTION_TAGS } from './actions.ts';

// Adapted from upstream mini-swe-agent's mini_textbased.yaml (SWE-agent/mini-swe-agent at
// 04d809c). The workflow and the one-action rule are upstream's. The command examples are
// ours: Tier 1 has no sed or echo, edits go through the edit tool, and submitting is its
// own action instead of a magic echo.

// Scenarios only break the demo app, so the prompt points the agent at it. Root scripts
// would also run depcruise, which the sandbox image doesn't carry.
const APP = 'apps/demo-app';
const PNPM = 'pnpm --filter @page/demo-app';

const { exec: BASH, edit: EDIT, submit: SUBMIT } = ACTION_TAGS;
const FENCE = '```';

export interface AgentTask {
  /** The bug report: what broke, the error, and where it showed up. */
  task: string;
}

export function systemPrompt(): string {
  return `You are a careful software engineer fixing a bug in a TypeScript repository. You work by running shell commands and editing files, one action at a time.

Your response must contain exactly ONE action block. Put a THOUGHT section before it that explains your reasoning.

There are three kinds of action block:

1. A shell command:

${FENCE}${BASH}
your_command_here
${FENCE}

2. An edit to one file:

${FENCE}${EDIT}
path/to/file.ts
<<<<<<< SEARCH
the exact text to replace
=======
the new text
>>>>>>> REPLACE
${FENCE}

3. Submitting your work, once the fix is in and the tests pass:

${FENCE}${SUBMIT}
${FENCE}

Failure to follow these rules will cause your response to be rejected.`;
}

export function instancePrompt({ task }: AgentTask): string {
  return `Please fix this bug:

<bug_report>
${task}
</bug_report>

## Recommended workflow

Work step by step so you can check each change as you go.

1. Find and read the code involved in the bug.
2. Find or write a test that shows the bug, and run it to see it fail.
3. Edit the source code to fix the bug.
4. Run the test again to confirm the fix, then the whole suite, lint and typecheck: \`${PNPM} test\`, \`${PNPM} lint\` and \`${PNPM} typecheck\`.
5. Submit with a ${SUBMIT} block. Do not put anything else in that response. After you submit, you cannot continue working on this task.

## Rules

1. Every response must contain exactly one action block.
2. Each command runs in a fresh shell in the repository root. The app is in \`${APP}\`. \`cd\` and environment variables do not carry over to the next command.
3. Only these programs are available: cat, ls, head, tail, rg, find, git (status, diff and log only) and pnpm (test, lint, typecheck, vitest, tsc and eslint). Anything else is refused.
4. Commands may use pipes, \`&&\`, \`||\`, \`;\` and redirects to files inside the repository. Globs, \`$\` variables, backticks, \`$(...)\`, heredocs and subshells are refused, so quote patterns and pass paths explicitly. Quote paths that contain brackets, such as Next.js route folders: \`cat -n "app/orders/[id]/page.tsx"\`.
5. Change files only with ${EDIT} blocks. The SEARCH text must match the file exactly, including indentation, and appear exactly once. Use an empty SEARCH section to create a new file.
6. Command output is cut to about 8,000 characters, keeping the start and the end. Narrow your command if you need the middle.

## Useful command examples

### Find where something is defined or used

${FENCE}${BASH}
rg -n "getCart" ${APP}/src
${FENCE}

### View specific lines of a file

${FENCE}${BASH}
cat -n ${APP}/src/shop/cart.ts | head -40
${FENCE}

### Find files by name

${FENCE}${BASH}
find ${APP}/src -name "*.test.ts"
${FENCE}

### Run one test file (the path is relative to the app)

${FENCE}${BASH}
${PNPM} exec vitest run src/shop/cart.test.ts
${FENCE}

### Replace a line

${FENCE}${EDIT}
${APP}/src/shop/cart.ts
<<<<<<< SEARCH
  if (quantity < 0) {
=======
  if (quantity <= 0) {
>>>>>>> REPLACE
${FENCE}`;
}

const output = (text: string) => `<output>\n${text}\n</output>`;

/** What the model sees after an action runs. */
export function observationPrompt(result: Result<ExecOk, ExecErr>): string {
  if (result.ok) return `<returncode>0</returncode>\n${output(result.value.output)}`;
  const e = result.error;
  switch (e.type) {
    case 'failed':
      return `<returncode>${e.exitCode}</returncode>\n${output(e.output)}`;
    case 'timed_out':
      return `<timed_out/>\n${output(e.output)}`;
    case 'refused':
      return `<refused>${e.message}</refused>\nThe command was refused, so nothing ran. Try a different command that the rules allow.`;
  }
}

/** Sent back when a reply has no usable action. */
export function formatErrorPrompt(error: string, finishReason: string | null): string {
  if (finishReason === 'length') {
    return 'Your previous response reached the output token limit before it had a complete action, so it was cut off. Respond more concisely, with exactly one action block. If you need to think more, keep it brief.';
  }
  return `Format error:

<error>
${error}
</error>

Every response must contain exactly ONE action block: ${FENCE}${BASH} for a command, ${FENCE}${EDIT} for an edit, or ${FENCE}${SUBMIT} when you are done. For example:

<response_example>
THOUGHT: why you want to take this action.

${FENCE}${BASH}
<command>
${FENCE}
</response_example>

If you have finished the task, submit with a ${SUBMIT} block. You cannot continue working after that.`;
}
