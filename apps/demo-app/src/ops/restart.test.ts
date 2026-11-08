import { afterEach, describe, expect, it, vi } from 'vitest';
import { processRestarter, RESTART_DELAY_MS, RESTART_EXIT_CODE } from './restart.ts';

describe('processRestarter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exits non-zero once, after the delay', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const restarter = processRestarter(exit);
    restarter.schedule();
    restarter.schedule();
    vi.advanceTimersByTime(RESTART_DELAY_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(RESTART_EXIT_CODE);
  });

  it('defaults to process.exit', () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    processRestarter().schedule();
    vi.runAllTimers();
    expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE);
    exit.mockRestore();
  });
});
