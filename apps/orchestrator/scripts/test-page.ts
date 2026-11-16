// Usage: pnpm --filter @page/orchestrator page:test [--sms-body <text>]
// Places one test call and sends one test SMS to every NOTIFY_TO_NUMBERS phone through the
// real Twilio adapter, with the TWILIO_* settings in the repo's .env. Exits 1 if any page
// failed. A trial account only sends template bodies, so on trial pass
// `--sms-body sms_internal_alerts` (docs/twilio.md).
import process from 'node:process';
import { parseArgs } from 'node:util';
import { splitNumbers } from '../src/config.ts';
import { TwilioPager } from '../src/notify/pager.ts';
import { maskNumber, sendTestPages } from '../src/notify/test-page.ts';

const USAGE = 'usage: pnpm --filter @page/orchestrator page:test [--sms-body <text>]';
const CALL_MESSAGE = 'This is a page dot A I test call. No action needed.';
const SMS_BODY = 'page.ai test page. No action needed.';

// pnpm passes a `--` through, and parseArgs would read every flag after it as positional.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
let smsBody = SMS_BODY;
try {
  const { values } = parseArgs({ args, options: { 'sms-body': { type: 'string' } } });
  smsBody = values['sms-body'] ?? SMS_BODY;
} catch {
  console.error(USAGE);
  process.exit(2);
}

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
const from = process.env.TWILIO_FROM_NUMBER?.trim();
const numbers = splitNumbers(process.env.NOTIFY_TO_NUMBERS);
if (!accountSid || !authToken || !from || numbers.length === 0) {
  console.error(
    'set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and NOTIFY_TO_NUMBERS in .env',
  );
  process.exit(2);
}

const results = await sendTestPages(
  new TwilioPager({ accountSid, authToken, from }),
  numbers,
  CALL_MESSAGE,
  smsBody,
);
for (const { to, channel, error } of results) {
  console.log(`${maskNumber(to)} ${channel} ${error ? `FAILED ${error}` : 'sent'}`);
}
if (results.some((result) => result.error)) process.exit(1);
