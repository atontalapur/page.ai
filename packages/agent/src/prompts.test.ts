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
    expect(systemPrompt(3)).toBe(tier2);
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
