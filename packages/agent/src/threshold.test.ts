import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_CONFIG, runAgent } from './agent.ts';
import { bash, fakeExecute, ScriptedModel } from './test-utils.ts';
import { budgetFor, ESCALATION_THRESHOLD } from './threshold.ts';

const task = { task: 'GET /products returns 500: RangeError: Invalid currency code : USDD' };
const TIERS = [1, 2, 3] as const;

describe('ESCALATION_THRESHOLD', () => {
  it.each(TIERS)('gives Tier %i positive limits that end before the sandbox does', (tier) => {
    const { stepLimit, costLimitUsd, wallTimeLimitMs } = ESCALATION_THRESHOLD[tier];
    expect(stepLimit).toBeGreaterThan(0);
    expect(costLimitUsd).toBeGreaterThan(0);
    // The sandbox container sleeps 900 s (apps/node/src/sandbox/run-args.ts).
    expect(wallTimeLimitMs).toBeGreaterThan(0);
    expect(wallTimeLimitMs).toBeLessThan(15 * 60 * 1000);
  });

  it("is Tier 1's in DEFAULT_AGENT_CONFIG", () => {
    expect(DEFAULT_AGENT_CONFIG).toMatchObject(ESCALATION_THRESHOLD[1]);
  });

  it('hands out copies, so a caller narrowing one leaves the threshold alone', () => {
    const budget = budgetFor(2);
    budget.stepLimit = 1;
    expect(ESCALATION_THRESHOLD[2].stepLimit).not.toBe(1);
  });

  it.each(TIERS)("stops a Tier %i run at that tier's step limit", async (tier) => {
    const { stepLimit } = ESCALATION_THRESHOLD[tier];
    const model = new ScriptedModel(Array.from({ length: stepLimit + 1 }, () => bash('ls')));
    const result = await runAgent({ ...task, tier }, { model, ...fakeExecute() });
    expect(result).toMatchObject({ exitStatus: 'step_limit', modelCalls: stepLimit });
  });

  it('lets an override narrow the tier budget', async () => {
    const model = new ScriptedModel([bash('ls'), bash('ls'), bash('ls')]);
    const result = await runAgent(
      { ...task, tier: 2 },
      { model, ...fakeExecute() },
      { stepLimit: 2 },
    );
    expect(result).toMatchObject({ exitStatus: 'step_limit', modelCalls: 2 });
  });
});
