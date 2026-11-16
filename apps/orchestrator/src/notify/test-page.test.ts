import { describe, expect, it } from 'vitest';
import { FakePager } from './pager.ts';
import { sendTestPages } from './test-page.ts';

describe('sendTestPages', () => {
  it('calls and texts every number, and keeps going after a failure', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    const results = await sendTestPages(pager, ['+15550000001', '+15550000002'], 'hi', 'body');
    expect(results).toEqual([
      { to: '+15550000001', channel: 'call', error: 'call failed' },
      { to: '+15550000001', channel: 'sms' },
      { to: '+15550000002', channel: 'call' },
      { to: '+15550000002', channel: 'sms' },
    ]);
    expect(pager.calls).toEqual([{ to: '+15550000002', message: 'hi' }]);
    expect(pager.texts.map((t) => t.message)).toEqual(['body', 'body']);
  });

  it('masks phone numbers in Twilio errors', async () => {
    const pager = new FakePager();
    pager.call = () =>
      Promise.reject(new Error('twilio 400: The number +15550000001 is unverified.'));
    const [call] = await sendTestPages(pager, ['+15550000001'], 'hi', 'body');
    expect(call?.error).toBe('twilio 400: The number ***0001 is unverified.');
  });
});
