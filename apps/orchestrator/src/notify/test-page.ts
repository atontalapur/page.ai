import { maskNumbers } from './mask.ts';
import type { Pager } from './pager.ts';

export interface TestPageResult {
  to: string;
  channel: 'call' | 'sms';
  /** Set when Twilio rejected the request. */
  error?: string;
}

/**
 * Places one call and sends one SMS to each number, and returns every result. A failure
 * doesn't stop the run, so one run shows every phone that isn't set up yet. Errors have
 * their phone numbers masked, so the output can be pasted into a public issue.
 */
export async function sendTestPages(
  pager: Pager,
  numbers: string[],
  callMessage: string,
  smsBody: string,
): Promise<TestPageResult[]> {
  const results: TestPageResult[] = [];
  for (const to of numbers) {
    for (const channel of ['call', 'sms'] as const) {
      try {
        if (channel === 'call') await pager.call(to, callMessage);
        else await pager.sms(to, smsBody);
        results.push({ to, channel });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ to, channel, error: maskNumbers(message) });
      }
    }
  }
  return results;
}
