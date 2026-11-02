import { describe, expect, it } from 'vitest';
import { formatErrorPrompt, instancePrompt, observationPrompt, systemPrompt } from './prompts.ts';

const exec = { kind: 'exec' as const, input: 'pnpm test' };

describe('systemPrompt', () => {
  it('names all three action blocks', () => {
    const prompt = systemPrompt();
    for (const tag of ['page_bash', 'page_edit', 'page_submit']) expect(prompt).toContain(tag);
  });
});

describe('instancePrompt', () => {
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
