import type { Pager } from './pager.ts';

export interface TestPageResult {
  to: string;
  channel: 'call' | 'sms';
  /** Set when Twilio rejected the request. */
  error?: string;
}

/** The last four digits only, so a run's output can go in an issue comment. */
export function maskNumber(number: string): string {
  return number.length > 4 ? `***${number.slice(-4)}` : '***';
}

/** Masks every E.164-looking number in text, such as a Twilio error naming the recipient. */
export function maskNumbers(text: string): string {
  return text.replaceAll(/\+\d{8,15}/g, maskNumber);
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
