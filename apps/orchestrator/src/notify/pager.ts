import type { Config } from '../config.ts';

export interface Pager {
  call(to: string, message: string): Promise<void>;
  sms(to: string, message: string): Promise<void>;
}

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  from: string;
}

/** Records pages in memory. Used in tests and when Twilio is not configured. */
export class FakePager implements Pager {
  readonly calls: { to: string; message: string }[] = [];
  readonly texts: { to: string; message: string }[] = [];
  /** The next N calls throw, then calls succeed. */
  failCalls = 0;

  call(to: string, message: string): Promise<void> {
    if (this.failCalls > 0) {
      this.failCalls -= 1;
      return Promise.reject(new Error('call failed'));
    }
    this.calls.push({ to, message });
    return Promise.resolve();
  }

  sms(to: string, message: string): Promise<void> {
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

/** Twilio REST adapter. A non-2xx response throws so the notify job can retry. */
export class TwilioPager implements Pager {
  constructor(
    private readonly creds: TwilioCreds,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  call(to: string, message: string): Promise<void> {
    const twiml = `<Response><Say>${escapeXml(message)}</Say></Response>`;
    return this.form('Calls.json', { To: to, From: this.creds.from, Twiml: twiml });
  }

  sms(to: string, message: string): Promise<void> {
    return this.form('Messages.json', { To: to, From: this.creds.from, Body: message });
  }

  private async form(path: string, fields: Record<string, string>): Promise<void> {
    const { accountSid, authToken } = this.creds;
    const authorization = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
    const response = await this.fetchFn(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/${path}`,
      {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(fields),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`twilio ${response.status}: ${text.slice(0, 300)}`);
    }
  }
}

/** Fake pager when adapters are fake, or when the Twilio settings are incomplete. */
export function buildPager(config: Config): Pager {
  if (config.useFakeAdapters || !config.twilio || config.notifyTo.length === 0) {
    return new FakePager();
  }
  return new TwilioPager(config.twilio);
}
