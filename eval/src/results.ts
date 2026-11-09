import { readFile } from 'node:fs/promises';
import type { ExitStatus } from '@page/agent';
import { bugClassSchema, tierSchema } from '@page/contracts';
import { z } from 'zod';

// Every way an agent run ends. The check below fails typecheck if @page/agent adds one.
const EXIT_STATUSES = [
  'submitted',
  'step_limit',
  'cost_limit',
  'time_limit',
  'format_errors',
  'model_error',
  'audit_failed',
  'aborted',
] as const satisfies readonly ExitStatus[];
const everyExitStatus: Exclude<ExitStatus, (typeof EXIT_STATUSES)[number]> extends never
  ? true
  : false = true;
void everyExitStatus;
export const exitStatusSchema = z.enum(EXIT_STATUSES);

// The tiers each configuration tries, in order. A run moves up when the agent runs out of
// budget, the way the daemon escalates an issue.
export const EVAL_CONFIGS = {
  'tier1-only': [1],
  'tier3-start': [3],
  ladder: [1, 2, 3],
} as const;
export type EvalConfig = keyof typeof EVAL_CONFIGS;
export const evalConfigSchema = z.enum(Object.keys(EVAL_CONFIGS) as [EvalConfig, ...EvalConfig[]]);

const costSchema = z.number().nonnegative();
const msSchema = z.int().nonnegative();

/** One agent run at one tier, in a fresh sandbox broken by the scenario's break.sh. */
export const attemptSchema = z.strictObject({
  tier: tierSchema,
  exitStatus: exitStatusSchema,
  /** check.sh on the agent's diff, whether or not it submitted. */
  checkPassed: z.boolean(),
  /** Set when the agent opened a PR (Tier 2 and up). Eval runs use a fake GitHub. */
  prOpened: z.boolean(),
  modelCalls: z.int().nonnegative(),
  costUsd: costSchema,
  durationMs: msSchema,
  steps: z.int().nonnegative(),
  /** execute() calls the policy refused. */
  blockedSteps: z.int().nonnegative(),
  diff: z.string(),
});
export type Attempt = z.infer<typeof attemptSchema>;

/** One scenario played once under a configuration: one attempt per tier it reached. */
export const scenarioRunSchema = z.strictObject({
  scenario: z.string(),
  class: bugClassSchema,
  expectedTier: tierSchema,
  run: z.int().positive(),
  attempts: z.array(attemptSchema),
  /** The tier whose agent submitted. Null when every tier gave up. */
  tierLanded: tierSchema.nullable(),
  /** The submitted patch passed check.sh. */
  fixed: z.boolean(),
  /** Every tier gave up, so a human gets paged. */
  paged: z.boolean(),
  timeToFixMs: msSchema.nullable(),
  timeToPageMs: msSchema.nullable(),
  /** Tiers that escalated although their patch already passed check.sh. */
  falseEscalations: z.int().nonnegative(),
  /** The run paged although the last tier's patch already passed check.sh. */
  falsePage: z.boolean(),
  costUsd: costSchema,
});
export type ScenarioRun = z.infer<typeof scenarioRunSchema>;

export const evalSummarySchema = z.strictObject({
  runs: z.int().nonnegative(),
  fixed: z.int().nonnegative(),
  fixRate: z.number().min(0).max(1),
  costUsd: costSchema,
  /** Null when nothing was fixed. */
  costPerFixUsd: costSchema.nullable(),
  falseEscalations: z.int().nonnegative(),
  falsePages: z.int().nonnegative(),
  steps: z.int().nonnegative(),
  blockedSteps: z.int().nonnegative(),
  /** Null when no step ran. */
  blockedPer100Steps: z.number().nonnegative().nullable(),
});
export type EvalSummary = z.infer<typeof evalSummarySchema>;

export const evalResultsSchema = z.strictObject({
  v: z.literal(1),
  config: evalConfigSchema,
  model: z.string().min(1),
  gitSha: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  runsPerScenario: z.int().positive(),
  maxCostUsd: costSchema,
  /**
   * Everything charged against maxCostUsd, including runs the budget cut short and
   * attempts that threw. summary.costUsd counts only the runs in `runs`.
   */
  spentUsd: costSchema,
  /** The budget ran out before every planned run finished. */
  stoppedForBudget: z.boolean(),
  /**
   * A model provider error (rate limit, quota, outage) stopped the eval. The run it hit is
   * in `errors`, not counted as a page. Files from before this field read as false.
   */
  stoppedForProvider: z.boolean().default(false),
  runs: z.array(scenarioRunSchema),
  skipped: z.array(z.strictObject({ scenario: z.string(), reason: z.string() })),
  /** Attempts that threw (sandbox, script or model provider failure). Their runs are left out. */
  errors: z.array(
    z.strictObject({
      scenario: z.string(),
      run: z.int().positive(),
      tier: tierSchema,
      message: z.string(),
    }),
  ),
  summary: evalSummarySchema,
});
export type EvalResults = z.infer<typeof evalResultsSchema>;

export async function loadResults(path: string): Promise<EvalResults> {
  return evalResultsSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
