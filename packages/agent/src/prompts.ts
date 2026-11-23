import {
  MAX_RESTARTS,
  type ExecContext,
  type ExecErr,
  type ExecOk,
  type Result,
} from '@page/toolkit';
import { ACTION_TAGS } from './actions.ts';

// Adapted from upstream mini-swe-agent's mini_textbased.yaml (SWE-agent/mini-swe-agent at
// 04d809c). The workflow and the one-action rule are upstream's. The command examples are
// ours: Tier 1 has no sed or echo, edits go through the edit tool, and submitting is its
// own action instead of a magic echo.

// Scenarios only break the demo app, so the prompt points the agent at it. Root scripts
// would also run depcruise, which the sandbox image doesn't carry.
const APP = 'apps/demo-app';
const PNPM = 'pnpm --filter @page/demo-app';

const {
  exec: BASH,
  edit: EDIT,
  submit: SUBMIT,
  pushBranch: PUSH,
  openPr: OPEN_PR,
  opsConfig: OPS_CONFIG,
  opsSet: OPS_SET,
  opsUnset: OPS_UNSET,
  opsRestart: OPS_RESTART,
  opsRollbackPlan: OPS_ROLLBACK_PLAN,
  opsRollback: OPS_ROLLBACK,
} = ACTION_TAGS;
const FENCE = '```';

type Tier = ExecContext['tier'];

export interface AgentTask {
  /** The bug report: what broke, the error, and where it showed up. */
  task: string;
  /** The run's tier. From Tier 2 the agent pushes its fix and opens a PR. Unset is Tier 1. */
  tier?: Tier;
  /**
   * Whether a Tier 3 run can roll back the live app's deploy, because the node has a
   * deployer for it. Unset is false, and the prompt leaves the rollback blocks out.
   */
  rollback?: boolean;
  /**
   * Whether a person approves each of a Tier 3 run's changes to the live app before it runs
   * (APPROVAL_TOOLS in @page/toolkit), so the run waits for them. Unset is false: the eval and
   * a daemon with AUTO_APPROVE_OPS approve those calls at once, and the prompt stays the one
   * the recorded eval runs saw (prompts.test.ts pins it).
   */
  personApproves?: boolean;
}

// Tier 2 and up push the fix and open a PR through the host tools.
const publishes = (tier: Tier | undefined) => tier !== undefined && tier >= 2;

const PUBLISH_BLOCKS = `3. Pushing your changes to this run's branch, with the commit message:

${FENCE}${PUSH}
fix(cart): reject a zero quantity
${FENCE}

4. Opening a pull request from that branch, once it is pushed. The first line is the title and the rest is the description:

${FENCE}${OPEN_PR}
fix(cart): reject a zero quantity
What was broken, why, and how you checked the fix.
${FENCE}

`;

// Tier 3 also reads and changes the live app's settings through the ops tools.
const operates = (tier: Tier | undefined) => tier !== undefined && tier >= 3;

// Examples name no real setting, so they can't hint at a fix.
const OPS_BLOCKS = `5. Reading the live app's settings: where each one comes from (its env value or a runtime config override) and what a restart would load:

${FENCE}${OPS_CONFIG}
${FENCE}

6. Setting a runtime config override, as SETTING_NAME=value. It applies when the app restarts:

${FENCE}${OPS_SET}
SETTING_NAME=value
${FENCE}

7. Dropping a runtime config override, so the env value applies again when the app restarts:

${FENCE}${OPS_UNSET}
SETTING_NAME
${FENCE}

8. Restarting the live app so a settings change applies. It waits until the app answers again:

${FENCE}${OPS_RESTART}
${FENCE}

`;

// A Tier 3 run on a node with a deployer can also roll the live app back.
const rollsBack = (tier: Tier | undefined, rollback: boolean | undefined) =>
  operates(tier) && rollback === true;

// The id is a placeholder, like the setting name above.
const ROLLBACK_BLOCKS = `9. Planning a rollback of the live app's deploy. It is a dry run: it shows the live deployment and the earlier one a rollback would bring back, and changes nothing:

${FENCE}${OPS_ROLLBACK_PLAN}
${FENCE}

10. Rolling the live app back to the deployment the plan named, by its id. It waits until that build is live:

${FENCE}${OPS_ROLLBACK}
DEPLOYMENT_ID
${FENCE}

`;

/** The submit block's number and when to use it, for each tier's list of blocks. */
function submitLine(tier: Tier | undefined, rollback: boolean): string {
  if (rollsBack(tier, rollback)) {
    return `${PUBLISH_BLOCKS}${OPS_BLOCKS}${ROLLBACK_BLOCKS}11. Submitting your work, once the fix is in: for a code change, after the tests pass and the pull request is open; for a settings change, after the app has restarted with it; for a rollback, once the build it brought back is live`;
  }
  if (operates(tier)) {
    return `${PUBLISH_BLOCKS}${OPS_BLOCKS}9. Submitting your work, once the fix is in: for a code change, after the tests pass and the pull request is open; for a settings change, after the app has restarted with it`;
  }
  const publish = publishes(tier);
  return `${publish ? `${PUBLISH_BLOCKS}5` : '3'}. Submitting your work, once the fix is in and the tests pass${publish ? ' and the pull request is open' : ''}`;
}

/** The system prompt. `rollback` adds the rollback blocks at Tier 3; see AgentTask. */
export function systemPrompt(tier?: Tier, rollback = false): string {
  const kinds = rollsBack(tier, rollback)
    ? 'eleven'
    : operates(tier)
      ? 'nine'
      : publishes(tier)
        ? 'five'
        : 'three';
  return `You are a careful software engineer fixing a bug in a TypeScript repository. You work by running shell commands and editing files, one action at a time.

Your response must contain exactly ONE action block. Put a THOUGHT section before it that explains your reasoning.

There are ${kinds} kinds of action block:

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

${submitLine(tier, rollback)}:

${FENCE}${SUBMIT}
${FENCE}

Failure to follow these rules will cause your response to be rejected.`;
}

const PUBLISH_STEP = `5. Push your changes with a ${PUSH} block, then open a pull request with a ${OPEN_PR} block.
`;

const OPS_SECTION = `## The live app's settings

The bug may come from the live app's settings rather than its code. The app reads its shop settings from env values, and a runtime config override replaces one. A change to an override applies only after a restart. If the code handles its inputs correctly, read the live settings with a ${OPS_CONFIG} block. To fix a bad setting, drop or correct its override, restart the app with a ${OPS_RESTART} block, and then submit: a settings fix needs no code change or pull request. You may restart the app at most ${MAX_RESTARTS} times.

`;

// When a rollback is the fix, and when it isn't. It names no file or route, so it can't
// hint at a fix either.
const ROLLBACK_SECTION = `## A bad deploy

The live app may run a build that differs from the code in this repository: a bad deploy. Suspect one when the code here can't produce the error, for example when the stack trace points at lines that read differently here, or the code handles the failing request correctly, and the live settings look right. Then plan a rollback with a ${OPS_ROLLBACK_PLAN} block: it shows the live deployment, when it was created, and the earlier one a rollback would bring back. If the live build is the bad one, roll back with a ${OPS_ROLLBACK} block that holds the id the plan named, and then submit: a rollback needs no code change or pull request. Don't roll back to fix a bug that is in this repository's code, since the next deploy would bring it back; fix the code instead. You may roll back once.

`;

// Only when a person answers. An auto-approved run never waits, so it gets no section.
const asksPerson = (tier: Tier | undefined, personApproves: boolean | undefined) =>
  operates(tier) && personApproves === true;

/**
 * Which blocks wait for a person, what a wait costs, and what to do with a no. It names no
 * setting either.
 */
function approvalSection(rollback: boolean): string {
  const changes = rollback
    ? `${OPS_SET}, ${OPS_UNSET}, ${OPS_RESTART} and ${OPS_ROLLBACK}`
    : `${OPS_SET}, ${OPS_UNSET} and ${OPS_RESTART}`;
  const reads = rollback
    ? 'Reading the settings and planning a rollback need'
    : 'Reading the settings needs';
  return `## Changes a person approves

A person approves each change to the live app before it runs: every ${changes} block. ${reads} no approval. The person sees the block and the THOUGHT before it, so say there what the change does and why it fixes the bug. An answer can take a few minutes, and the wait counts against your time.

Ask for as few approvals as the fix needs. Read the settings and find the cause before you change anything. Then make every settings change the fix needs, and restart once, after the last one.${rollback ? ' A rollback needs no restart after it.' : ''}

If the person rejects a change, or no one answers in time, the block comes back refused and does not run. Don't ask for the same change again hoping for a different answer. Try a different fix with the blocks you have. If there is none, submit: a run that submits without a working fix goes to a person, who sees each step you took and the THOUGHT before it.

`;
}

export function instancePrompt({ task, tier, rollback, personApproves }: AgentTask): string {
  const publish = publishes(tier);
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
${publish ? `${PUBLISH_STEP}6` : '5'}. Submit with a ${SUBMIT} block. Do not put anything else in that response. After you submit, you cannot continue working on this task.

${operates(tier) ? OPS_SECTION : ''}${rollsBack(tier, rollback) ? ROLLBACK_SECTION : ''}${asksPerson(tier, personApproves) ? approvalSection(rollsBack(tier, rollback)) : ''}## Rules

1. Every response must contain exactly one action block.
2. Each command runs in a fresh shell in the repository root. The app is in \`${APP}\`. \`cd\` and environment variables do not carry over to the next command.
3. Only these programs are available: cat, ls, head, tail, rg, find, git (status, diff and log only) and pnpm (test, lint, typecheck, vitest, tsc and eslint). Anything else is refused, including grep, xargs, sed, echo and cd: search with rg, and give each command its paths directly.
4. Commands may use pipes, \`&&\`, \`||\`, \`;\` and redirects to files inside the repository. Globs, \`$\` variables, backticks, \`$(...)\`, heredocs and subshells are refused, so quote patterns and pass paths explicitly. Quote paths that contain brackets, such as Next.js route folders: \`cat -n "app/orders/[id]/page.tsx"\`.
5. Change files only with ${EDIT} blocks. The SEARCH text must match the file exactly, including indentation, and appear exactly once. Use an empty SEARCH section to create a new file.
6. Command output is cut to about 8,000 characters, keeping the start and the end. Narrow your command if you need the middle.

## Useful command examples

### Find where something is defined or used

${FENCE}${BASH}
rg -n "getCart" ${APP}/src
${FENCE}

### Search only TypeScript files (\`-t ts\` covers .ts and .tsx; there is no tsx type)

${FENCE}${BASH}
rg -n -t ts "getCart" ${APP}/src
${FENCE}

### View specific lines of a file

${FENCE}${BASH}
cat -n ${APP}/src/shop/cart.ts | head -40
${FENCE}

### Read a file whose path has brackets, quoted

${FENCE}${BASH}
cat -n "${APP}/src/app/orders/[id]/page.tsx"
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
    case 'audit_failed':
      // runAgent ends the run on this before it builds an observation.
      throw new Error(`no observation for an unaudited step: ${e.message}`);
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
