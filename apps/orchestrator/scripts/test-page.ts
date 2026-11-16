// Usage: pnpm --filter @page/orchestrator page:test [--sms-body <text>]
// Places one test call and sends one test SMS to every NOTIFY_TO_NUMBERS phone through the
// real Twilio adapter, with the TWILIO_* settings in the repo's .env (or Railway's, under
// `railway run`). Exits 1 if any page failed. A trial account only sends template bodies,
// so on trial pass `--sms-body sms_internal_alerts` (docs/twilio.md).
import process from 'node:process';
import { parseArgs } from 'node:util';
import { ConfigError, loadPagerConfig, type PagerConfig } from '../src/config.ts';
import { maskNumber } from '../src/notify/mask.ts';
import { TwilioPager } from '../src/notify/pager.ts';
import { sendTestPages } from '../src/notify/test-page.ts';

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

// The orchestrator's own parser, so a value that passes here passes there.
let pager: PagerConfig;
try {
  pager = loadPagerConfig(process.env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(err.message);
  process.exit(2);
}
if (!pager.twilio || pager.notifyTo.length === 0) {
  console.error(
    'set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER and NOTIFY_TO_NUMBERS in .env',
  );
  process.exit(2);
}

const results = await sendTestPages(
  new TwilioPager(pager.twilio),
  pager.notifyTo,
  CALL_MESSAGE,
  smsBody,
);
for (const { to, channel, error } of results) {
  console.log(`${maskNumber(to)} ${channel} ${error ? `FAILED ${error}` : 'sent'}`);
}
// exitCode, not exit(): Node flushes stdout first, so piped output keeps its last lines.
if (results.some((result) => result.error)) process.exitCode = 1;
