import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runAgent } from './agent.ts';
import type { AgentTask } from './prompts.ts';
import { fakeExecute, ScriptedModel, submit } from './test-utils.ts';

// The prompts an auto-approved run sees. The recorded eval results, and the calibration runs
// on the dev set, used the task prompt before the command notes of 2026-11-23 and before the
// stop-searching wording the same day (the system prompts are unchanged); see the note in
// docs/report/eval-prereg.md. An
// eval run approves every gated ops call at once (evalApprove in eval/src/approve.ts), and so
// does a daemon with AUTO_APPROVE_OPS, so neither may see a word about a person approving.
//
// If one of these fails, a change reached the prompt an auto-approved run sees, and the eval
// results no longer describe it. Put the prompt back, or rerun the eval and update the hash on
// purpose. `git diff packages/agent/src/prompts.ts` shows what changed.
const PINNED = {
  1: {
    system: '25740044faedb99e33ef0d80b397dbe44fc82d352f33362ca22fd427a1a375e0',
    instance: '7e6372206e4bc7a48346a3fd70116a82b91b162a33029acf790614699672b528',
  },
  2: {
    system: 'b33e10d1f05a4cd3cb727ebe008d413a1f923dca5c1c0cae1f0e2f4c5f363a0c',
    instance: 'f243f18984c1af9353bd62dcb3d8d004e05279cbd2a0270ecccbd5d010dfe877',
  },
  3: {
    system: 'd30586ac13c3bed867a2a89574adc8d684ec023c12e167ff1ceba24aac397291',
    instance: '61fe682c92bf4a5cc536139f70102110a615cd43caf0551020b6b2c0867b9d8f',
  },
} as const;

// A Tier 3 run on a node with a deployer and AUTO_APPROVE_OPS. The eval has no deployer.
const PINNED_ROLLBACK = {
  system: 'ddcd48bf7007cbad26a45dfd24b192b2e275c8cd21507e8011cb701de163d21b',
  instance: 'fecdd6f5d14bef8ca43f709ea741abfdc4f53fe0ea8013095590f54e1eb33b60',
};

const report = 'POST /api/checkout returns 500: TypeError: Cannot read properties of undefined';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The system and task prompts runAgent opens `task` with, hashed. */
async function opening(task: AgentTask): Promise<{ system: string; instance: string }> {
  const model = new ScriptedModel([submit()]);
  await runAgent(task, { model, ...fakeExecute() });
  const [system, instance] = model.calls[0]!;
  return { system: sha256(system!.content), instance: sha256(instance!.content) };
}

describe('the prompts an auto-approved run sees', () => {
  it.each([1, 2, 3] as const)(
    'is byte for byte the recorded eval prompt at Tier %i',
    async (tier) => {
      // As eval/scripts/attempt.ts calls it.
      expect(await opening({ task: report, tier })).toEqual(PINNED[tier]);
    },
  );

  it('is the same at Tier 3 when the run says no person approves', async () => {
    expect(await opening({ task: report, tier: 3, personApproves: false })).toEqual(PINNED[3]);
  });

  it('is the same at Tier 3 with a rollback and no person to approve', async () => {
    expect(await opening({ task: report, tier: 3, rollback: true })).toEqual(PINNED_ROLLBACK);
    expect(await opening({ task: report, tier: 3, rollback: true, personApproves: false })).toEqual(
      PINNED_ROLLBACK,
    );
  });

  it('changes when a person approves, so the pin above can tell', async () => {
    const asked = await opening({ task: report, tier: 3, personApproves: true });
    expect(asked.system).toBe(PINNED[3].system);
    expect(asked.instance).not.toBe(PINNED[3].instance);
  });
});
