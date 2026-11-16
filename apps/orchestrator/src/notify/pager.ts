import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Config, TwilioCreds } from '../config.ts';

export type { TwilioCreds };

export interface Pager {
  call(to: string, message: string): Promise<void>;
  sms(to: string, message: string): Promise<void>;
}

/** Records pages in memory. Used in tests and when Twilio is not configured. */
export class FakePager implements Pager {
  readonly calls: { to: string; message: string }[] = [];
  readonly texts: { to: string; message: string }[] = [];
  /** The next N calls throw, then calls succeed. */
  failCalls = 0;
  /** The next N texts throw, then texts succeed. */
  failTexts = 0;

  call(to: string, message: string): Promise<void> {
    if (this.failCalls > 0) {
      this.failCalls -= 1;
      return Promise.reject(new Error('call failed'));
    }
    this.calls.push({ to, message });
    return Promise.resolve();
  }

  sms(to: string, message: string): Promise<void> {
    if (this.failTexts > 0) {
      this.failTexts -= 1;
      return Promise.reject(new Error('sms failed'));
    }
    this.texts.push({ to, message });
    return Promise.resolve();
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

// A trial account's create-call request may carry only To and one of Twilio's template URLs
// (Url), and a text only one of its template bodies. See Twilio's "Try out Voice" and
// "Try out SMS" docs.
const TRIAL_CALL_URL = 'https://webhooks.twilio.com/v1/Voice/Template/voice_text_to_speech';
const TRIAL_SMS_BODY = 'sms_internal_alerts';

// Twilio's CallStatus values. in-progress and completed mean the phone was picked up.
const ANSWERED = new Set(['in-progress', 'completed']);
const NOT_ANSWERED = new Set(['busy', 'no-answer', 'failed', 'canceled']);
const FINAL = new Set([...ANSWERED, ...NOT_ANSWERED]);

const callSchema = z.object({
  sid: z.string().min(1),
  status: z.string().min(1),
  // Set by answering machine detection: human, machine_*, fax or unknown.
  answered_by: z.string().nullish(),
});

/** Voicemail or a fax took the call, so nobody heard the page. */
function machineAnswered(answeredBy: string | null | undefined): boolean {
  return answeredBy === 'fax' || (answeredBy?.startsWith('machine') ?? false);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface CallWait {
  /** Between status checks. */
  pollMs: number;
  /**
   * Longest wait for an answer. Twilio stops ringing after 60 s by default, and detection
   * listens for up to 30 s more.
   */
  maxWaitMs: number;
  sleep: (ms: number) => Promise<unknown>;
}

const defaultCallWait: CallWait = { pollMs: 2_000, maxWaitMs: 120_000, sleep };

/** Twilio REST adapter. A non-2xx response, or a call nobody answers, throws so the job retries. */
export class TwilioPager implements Pager {
  constructor(
    private readonly creds: TwilioCreds,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly wait: CallWait = defaultCallWait,
  ) {}

  /**
   * Places the call and waits until a person picks up. Busy, no answer, failed or canceled
   * throws, so the notify job retries this phone, and so does voicemail or a fax when
   * machine detection is on. Detection runs in DetectMessageEnd mode, so voicemail records
   * the whole message after the beep. `unknown` counts as a person: often someone who
   * answered and stayed quiet. Twilio's create response only says the call was queued, so
   * the status is polled. A call still unresolved after maxWaitMs resolves, since a retry
   * then could ring a phone that is about to pick up. On a trial account the call plays
   * Twilio's sample speech instead of the message, and detection is never sent.
   */
  async call(to: string, message: string): Promise<void> {
    const twiml = `<Response><Say>${escapeXml(message)}</Say></Response>`;
    const fields: Record<string, string> = this.creds.trial
      ? { To: to, Url: TRIAL_CALL_URL }
      : { To: to, From: this.creds.from, Twiml: twiml };
    const detect = this.creds.machineDetection && !this.creds.trial;
    if (detect) fields.MachineDetection = 'DetectMessageEnd';
    const placed = callSchema.safeParse(parseJson(await this.request('Calls.json', fields)));
    // Twilio accepted the call. Without its sid it can't be watched, and throwing would ring
    // the phone again, so count it as placed.
    if (!placed.success) return;
    const { pollMs, maxWaitMs } = this.wait;
    let call = placed.data;
    // While the call is in progress, detection may still be listening.
    const settled = () =>
      FINAL.has(call.status) && !(detect && call.status === 'in-progress' && !call.answered_by);
    for (let waited = 0; !settled() && waited < maxWaitMs; waited += pollMs) {
      await this.wait.sleep(pollMs);
      try {
        const path = `Calls/${encodeURIComponent(call.sid)}.json`;
        call = callSchema.parse(parseJson(await this.request(path)));
      } catch {
        // A failed status check is not a failed call. Keep waiting until the deadline.
      }
    }
    if (NOT_ANSWERED.has(call.status)) throw new Error(`call ${call.status}`);
    if (machineAnswered(call.answered_by)) throw new Error(`call answered by ${call.answered_by}`);
  }

  /** On a trial account the text is Twilio's alert template, since custom bodies are refused. */
  async sms(to: string, message: string): Promise<void> {
    const body = this.creds.trial ? TRIAL_SMS_BODY : message;
    await this.request('Messages.json', { To: to, From: this.creds.from, Body: body });
  }

  /** POSTs the fields as a form, or GETs when there are none, and returns the body. */
  private async request(path: string, fields?: Record<string, string>): Promise<string> {
    const { accountSid, authToken } = this.creds;
    const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const response = await this.fetchFn(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/${path}`,
      fields
        ? {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields),
          }
        : { method: 'GET', headers: { authorization } },
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`twilio ${response.status}: ${text.slice(0, 300)}`);
    return text;
  }
}

/** Fake pager when adapters are fake, or when the Twilio settings are incomplete. */
export function buildPager(config: Config): Pager {
  if (config.useFakeAdapters || !config.twilio || config.notifyTo.length === 0) {
    return new FakePager();
  }
  return new TwilioPager(config.twilio);
}
