import { describe, expect, it } from 'vitest';
import { formatErrorPrompt, instancePrompt, observationPrompt, systemPrompt } from './prompts.ts';

const exec = { kind: 'exec' as const, input: 'pnpm test' };

describe('systemPrompt', () => {
  it('names all three action blocks', () => {
    const prompt = systemPrompt();
    for (const tag of ['page_bash', 'page_edit', 'page_submit']) expect(prompt).toContain(tag);
  });
});

describe('systemPrompt at Tier 2', () => {
  it('adds the push and PR blocks, and leaves Tier 1 without them', () => {
    const tier2 = systemPrompt(2);
    expect(tier2).toContain('five kinds of action block');
    for (const tag of ['page_push_branch', 'page_open_pr']) {
      expect(tier2).toContain(tag);
      expect(systemPrompt(1)).not.toContain(tag);
    }
    expect(tier2).toContain('5. Submitting your work');
    expect(systemPrompt(1)).toBe(systemPrompt());
  });
});

const OPS_TAGS = ['page_ops_config', 'page_ops_set', 'page_ops_unset', 'page_ops_restart'];

describe('systemPrompt at Tier 3', () => {
  it('adds the ops blocks after the push and PR blocks, and only at Tier 3', () => {
    const tier3 = systemPrompt(3);
    expect(tier3).toContain('nine kinds of action block');
    for (const tag of ['page_push_branch', 'page_open_pr', ...OPS_TAGS]) {
      expect(tier3).toContain(tag);
    }
    for (const tag of OPS_TAGS) expect(systemPrompt(2)).not.toContain(tag);
    expect(tier3.match(/^\d\. /gm)).toEqual(
      ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => `${n}. `),
    );
    expect(tier3).toContain('for a settings change, after the app has restarted with it');
  });

  it("doesn't name a real setting, so the examples can't hint at a fix", () => {
    for (const prompt of [systemPrompt(3), instancePrompt({ task: 'x', tier: 3 })]) {
      expect(prompt).not.toMatch(/SHIPPING|FLAT_CENTS|FREE_SHIPPING/);
    }
  });
});

const ROLLBACK_TAGS = ['page_ops_rollback_plan', 'page_ops_rollback'];

describe('systemPrompt at Tier 3 with a rollback', () => {
  it('adds the rollback blocks after the ops blocks, and submit last', () => {
    const prompt = systemPrompt(3, true);
    expect(prompt).toContain('eleven kinds of action block');
    for (const tag of [...OPS_TAGS, ...ROLLBACK_TAGS]) expect(prompt).toContain(tag);
    expect(prompt.match(/^\d+\. /gm)).toEqual(Array.from({ length: 11 }, (_, i) => `${i + 1}. `));
    expect(prompt).toContain('11. Submitting your work');
    expect(prompt).toContain('for a rollback, once the build it brought back is live');
    expect(prompt.indexOf('page_ops_rollback_plan')).toBeGreaterThan(
      prompt.indexOf('page_ops_restart'),
    );
  });

  it('is left out without a rollback, and below Tier 3', () => {
    expect(systemPrompt(3, false)).toBe(systemPrompt(3));
    expect(systemPrompt(3)).not.toMatch(/rollback/i);
    expect(systemPrompt(2, true)).toBe(systemPrompt(2));
    expect(systemPrompt(1, true)).toBe(systemPrompt(1));
  });
});

describe('instancePrompt at Tier 3 with a rollback', () => {
  it('says when a rollback is the fix, and when it is not', () => {
    const prompt = instancePrompt({ task: 'x', tier: 3, rollback: true });
    expect(prompt).toContain('## A bad deploy');
    expect(prompt).toContain('plan a rollback with a page_ops_rollback_plan block');
    expect(prompt).toContain('roll back with a page_ops_rollback block');
    expect(prompt).toContain("Don't roll back to fix a bug that is in this repository's code");
    expect(prompt).toContain('You may roll back once.');
    expect(prompt.indexOf("## The live app's settings")).toBeLessThan(
      prompt.indexOf('## A bad deploy'),
    );
    expect(prompt.indexOf('## A bad deploy')).toBeLessThan(prompt.indexOf('## Rules'));
  });

  it('is left out without a rollback, and below Tier 3', () => {
    expect(instancePrompt({ task: 'x', tier: 3, rollback: false })).toBe(
      instancePrompt({ task: 'x', tier: 3 }),
    );
    expect(instancePrompt({ task: 'x', tier: 3 })).not.toMatch(/rollback|bad deploy/i);
    expect(instancePrompt({ task: 'x', tier: 2, rollback: true })).toBe(
      instancePrompt({ task: 'x', tier: 2 }),
    );
  });

  it("names no route or file, so it can't hint at a fix", () => {
    const prompt = `${systemPrompt(3, true)}\n${instancePrompt({ task: 'x', tier: 3, rollback: true })}`;
    const section = prompt.slice(prompt.indexOf('## A bad deploy'), prompt.indexOf('## Rules'));
    expect(section).not.toMatch(/products|limit|NaN|\/api\/|\.ts\b/);
  });
});

const APPROVALS = '## Changes a person approves';

describe('instancePrompt when a person approves the live app changes', () => {
  const asked = (rollback = false) =>
    instancePrompt({ task: 'x', tier: 3, rollback, personApproves: true });
  const section = (prompt: string) =>
    prompt.slice(prompt.indexOf(APPROVALS), prompt.indexOf('## Rules'));

  it('names the blocks that wait for a person, and the ones that do not', () => {
    const text = section(asked());
    expect(text).toContain(
      'A person approves each change to the live app before it runs: every page_ops_set, page_ops_unset and page_ops_restart block.',
    );
    expect(text).toContain('Reading the settings needs no approval.');
    expect(text).not.toMatch(/rollback/i);
  });

  it('adds the rollback to the blocks that wait, and the plan to the ones that do not', () => {
    const text = section(asked(true));
    expect(text).toContain(
      'every page_ops_set, page_ops_unset, page_ops_restart and page_ops_rollback block.',
    );
    expect(text).toContain('Reading the settings and planning a rollback need no approval.');
    expect(text).toContain('A rollback needs no restart after it.');
  });

  it('says a wait takes minutes of its time, and the person reads its THOUGHT', () => {
    const text = section(asked());
    expect(text).toContain(
      'An answer can take a few minutes, and the wait counts against your time.',
    );
    expect(text).toContain('The person sees the block and the THOUGHT before it');
  });

  it('asks it to batch its changes into as few approvals as it can', () => {
    const text = section(asked());
    expect(text).toContain('Ask for as few approvals as the fix needs.');
    expect(text).toContain('restart once, after the last one');
  });

  it('says what a rejection or no answer looks like, and what to do then', () => {
    const text = section(asked());
    expect(text).toContain(
      'If the person rejects a change, or no one answers in time, the block comes back refused and does not run.',
    );
    expect(text).toContain("Don't ask for the same change again hoping for a different answer.");
    expect(text).toContain('Try a different fix with the blocks you have.');
    expect(text).toContain('If there is none, submit');
  });

  it('comes after the ops and rollback sections and before the rules', () => {
    const prompt = asked(true);
    expect(prompt.indexOf('## A bad deploy')).toBeLessThan(prompt.indexOf(APPROVALS));
    expect(prompt.indexOf(APPROVALS)).toBeLessThan(prompt.indexOf('## Rules'));
  });

  it('is left out when calls are approved at once, and below Tier 3', () => {
    for (const rollback of [false, true]) {
      const auto = instancePrompt({ task: 'x', tier: 3, rollback });
      expect(auto).not.toContain(APPROVALS);
      expect(instancePrompt({ task: 'x', tier: 3, rollback, personApproves: false })).toBe(auto);
    }
    for (const tier of [1, 2] as const) {
      expect(instancePrompt({ task: 'x', tier, personApproves: true })).toBe(
        instancePrompt({ task: 'x', tier }),
      );
    }
    expect(instancePrompt({ task: 'x', personApproves: true })).not.toContain(APPROVALS);
  });

  it("names no setting, so it can't hint at a fix", () => {
    expect(section(asked(true))).not.toMatch(/SHIPPING|FLAT_CENTS|FREE_SHIPPING/);
  });

  it('leaves the system prompt alone', () => {
    // runAgent builds it from the tier and the rollback alone.
    expect(systemPrompt(3)).not.toMatch(/approv/i);
    expect(systemPrompt(3, true)).not.toMatch(/approv/i);
  });
});

describe('instancePrompt', () => {
  it('asks a Tier 2 run to push and open a PR before it submits', () => {
    const prompt = instancePrompt({ task: 'x', tier: 2 });
    expect(prompt).toContain('5. Push your changes with a page_push_branch block');
    expect(prompt).toContain('6. Submit with a page_submit block');
    expect(instancePrompt({ task: 'x', tier: 1 })).toBe(instancePrompt({ task: 'x' }));
    expect(instancePrompt({ task: 'x' })).not.toContain('page_push_branch');
  });

  it('tells a Tier 3 run about the live settings and the restart limit, and no lower tier', () => {
    const prompt = instancePrompt({ task: 'x', tier: 3 });
    expect(prompt).toContain("## The live app's settings");
    expect(prompt).toContain('read the live settings with a page_ops_config block');
    expect(prompt).toContain('restart the app at most 3 times');
    expect(prompt.indexOf("## The live app's settings")).toBeLessThan(prompt.indexOf('## Rules'));
    expect(instancePrompt({ task: 'x', tier: 2 })).not.toContain('page_ops');
  });

  it('includes the task and the commands the agent may run', () => {
    const prompt = instancePrompt({ task: 'checkout returns 500' });
    expect(prompt).toContain('checkout returns 500');
    expect(prompt).toContain('pnpm --filter @page/demo-app test');
    expect(prompt).not.toMatch(/sed -i|echo COMPLETE/);
  });
});

describe('observationPrompt', () => {
  it('shows a successful command its exit code and output', () => {
    const text = observationPrompt({ ok: true, value: { ...exec, exitCode: 0, output: 'ok' } });
    expect(text).toBe('<returncode>0</returncode>\n<output>\nok\n</output>');
  });

  it('shows a failed command its exit code and output', () => {
    const text = observationPrompt({
      ok: false,
      error: { ...exec, type: 'failed', exitCode: 2, output: 'boom' },
    });
    expect(text).toBe('<returncode>2</returncode>\n<output>\nboom\n</output>');
  });

  it('marks a timed out command', () => {
    const text = observationPrompt({
      ok: false,
      error: { ...exec, type: 'timed_out', output: 'partial\n[timed out after 5 ms]' },
    });
    expect(text).toBe('<timed_out/>\n<output>\npartial\n[timed out after 5 ms]\n</output>');
  });

  it('explains a refusal and says nothing ran', () => {
    const text = observationPrompt({
      ok: false,
      error: { ...exec, type: 'refused', message: 'refused: sed is not allowed' },
    });
    expect(text).toContain('<refused>refused: sed is not allowed</refused>');
    expect(text).toContain('nothing ran');
  });
});

describe('observationPrompt for an unaudited step', () => {
  it('throws, since the loop ends the run first', () => {
    expect(() =>
      observationPrompt({
        ok: false,
        error: { ...exec, type: 'audit_failed', ran: false, message: 'sink down' },
      }),
    ).toThrow(/unaudited step: sink down/);
  });
});

describe('formatErrorPrompt', () => {
  it('repeats the error and the expected format', () => {
    const text = formatErrorPrompt('Expected exactly 1 action, found 2.', 'stop');
    expect(text).toContain('Expected exactly 1 action, found 2.');
    expect(text).toContain('page_bash');
  });

  it('says the reply was cut off when the token limit was hit', () => {
    const text = formatErrorPrompt('Expected exactly 1 action, found 0.', 'length');
    expect(text).toContain('output token limit');
    expect(text).not.toContain('Expected exactly 1 action');
  });
});

describe('the knowledge graph in the prompts', () => {
  it('adds its blocks and section only when the run has it', () => {
    expect(systemPrompt(1, false, true)).toContain('page_kg_search');
    expect(systemPrompt(1, false, true)).toContain('page_kg_write');
    expect(systemPrompt(1)).not.toContain('page_kg');
    expect(instancePrompt({ task: 'x', knowledge: true })).toContain('## The knowledge graph');
    expect(instancePrompt({ task: 'x' })).not.toContain('knowledge graph');
  });
});
