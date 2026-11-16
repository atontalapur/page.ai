import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../db/test-utils.ts';
import { NotifyService } from './notify.service.ts';
import { buildPager, FakePager, TwilioPager } from './pager.ts';

const logger = pino({ enabled: false });
const issueId = '00000000-0000-4000-8000-000000000001';
const to = '+15551110000';
const callJob = { v: 2, issueId, channel: 'call', to, message: 'page' } as const;
const first = { retryCount: 0, retryLimit: 3 };
const last = { retryCount: 3, retryLimit: 3 };

describe('NotifyService', () => {
  it("calls and then texts the job's phone", async () => {
    const pager = new FakePager();
    await new NotifyService(pager, logger).deliver(callJob, first);
    expect(pager.calls).toEqual([{ to, message: 'page' }]);
    expect(pager.texts).toEqual([{ to, message: 'page' }]);
  });

  it('retries a failed call without sending SMS yet', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    await expect(new NotifyService(pager, logger).deliver(callJob, first)).rejects.toThrow(
      'call failed',
    );
    expect(pager.texts).toEqual([]);
  });

  it('completes without calling again when the follow-up SMS fails', async () => {
    const pager = new FakePager();
    pager.failTexts = 1;
    await new NotifyService(pager, logger).deliver(callJob, first);
    expect(pager.calls).toEqual([{ to, message: 'page' }]);
    expect(pager.texts).toEqual([]);
  });

  it('sends SMS when the last call attempt fails', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    await new NotifyService(pager, logger).deliver(callJob, last);
    expect(pager.calls).toEqual([]);
    expect(pager.texts).toEqual([{ to, message: 'page' }]);
  });

  it('fails the job when neither the last call nor its SMS goes through', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    pager.failTexts = 1;
    await expect(new NotifyService(pager, logger).deliver(callJob, last)).rejects.toThrow(
      'sms failed',
    );
  });

  it('sends only SMS when the job says so, and throws so a failed text retries', async () => {
    const pager = new FakePager();
    const service = new NotifyService(pager, logger);
    await service.deliver({ ...callJob, channel: 'sms' }, first);
    expect(pager.calls).toEqual([]);
    expect(pager.texts).toEqual([{ to, message: 'page' }]);
    pager.failTexts = 1;
    await expect(service.deliver({ ...callJob, channel: 'sms' }, first)).rejects.toThrow(
      'sms failed',
    );
  });
});

const creds = {
  accountSid: 'AC',
  authToken: 't',
  from: '+1',
  machineDetection: true,
  trial: false,
};

/**
 * Answers the call POST with the first state and each status check with the next. A state is
 * a CallStatus, `status:answeredBy`, or `error` for a failed check.
 */
function fakeTwilio(states: string[], machineDetection = true, trial = false) {
  const urls: string[] = [];
  const posted: URLSearchParams[] = [];
  let next = 0;
  const fetchFn: typeof fetch = (url, init) => {
    urls.push(url instanceof Request ? url.url : url.toString());
    if (init?.body instanceof URLSearchParams) posted.push(init.body);
    const state = states[Math.min(next, states.length - 1)] ?? 'completed';
    next += 1;
    if (state === 'error') return Promise.resolve(new Response('busy', { status: 503 }));
    const [status, answeredBy] = state.split(':');
    const body = { sid: 'CA1', status, answered_by: answeredBy ?? null };
    return Promise.resolve(Response.json(body, { status: 201 }));
  };
  const wait = { pollMs: 1_000, maxWaitMs: 5_000, sleep: () => Promise.resolve() };
  const pager = new TwilioPager({ ...creds, machineDetection, trial }, fetchFn, wait);
  return {
    pager,
    urls,
    posted,
    get statusChecks() {
      return urls.length - 1;
    },
  };
}

describe('TwilioPager', () => {
  it('posts the call and the SMS', async () => {
    const bodies: URLSearchParams[] = [];
    const fetchFn: typeof fetch = (_url, init) => {
      const body = init?.body;
      if (body instanceof URLSearchParams) bodies.push(body);
      else if (typeof body === 'string') bodies.push(new URLSearchParams(body));
      return Promise.resolve(Response.json({ sid: 'CA1', status: 'completed' }, { status: 201 }));
    };
    const pager = new TwilioPager({ ...creds, from: '+1000' }, fetchFn);
    await pager.call('+2000', 'high backend-api: Boom <x>');
    await pager.sms('+2000', 'high backend-api: Boom');
    expect(bodies[0]?.get('To')).toBe('+2000');
    expect(bodies[0]?.get('From')).toBe('+1000');
    expect(bodies[0]?.get('Twiml')).toContain('Boom');
    expect(bodies[0]?.get('Twiml')).not.toContain('<x>');
    expect(bodies[1]?.get('Body')).toContain('Boom');
  });

  it('waits for the call to be answered', async () => {
    const twilio = fakeTwilio(['queued', 'ringing', 'in-progress', 'completed']);
    await twilio.pager.call('+2000', 'page');
    // Detection on and no verdict yet, so in-progress keeps it waiting until completed.
    expect(twilio.statusChecks).toBe(3);
    expect(twilio.urls[1]).toMatch(/\/Calls\/CA1\.json$/);
  });

  it.each(['no-answer', 'busy', 'failed', 'canceled'])(
    'throws when the call ends %s, so the job retries',
    async (status) => {
      const twilio = fakeTwilio(['queued', 'ringing', status]);
      await expect(twilio.pager.call('+2000', 'page')).rejects.toThrow(`call ${status}`);
    },
  );

  it('asks Twilio to detect voicemail, and waits for its verdict', async () => {
    const twilio = fakeTwilio(['queued', 'in-progress', 'in-progress:human']);
    await twilio.pager.call('+2000', 'page');
    expect(twilio.posted[0]?.get('MachineDetection')).toBe('DetectMessageEnd');
    expect(twilio.statusChecks).toBe(2);
  });

  it.each(['machine_end_beep', 'machine_end_silence', 'machine_start', 'fax'])(
    'throws when %s answers, so the job retries',
    async (answeredBy) => {
      const twilio = fakeTwilio(['queued', `in-progress:${answeredBy}`]);
      await expect(twilio.pager.call('+2000', 'page')).rejects.toThrow(
        `call answered by ${answeredBy}`,
      );
    },
  );

  it('counts an unknown verdict as a person', async () => {
    const twilio = fakeTwilio(['queued', 'completed:unknown']);
    await expect(twilio.pager.call('+2000', 'page')).resolves.toBeUndefined();
  });

  it('sends only To and the speech template on a trial account', async () => {
    const twilio = fakeTwilio(['queued', 'in-progress'], true, true);
    await twilio.pager.call('+2000', 'page');
    expect([...(twilio.posted[0]?.keys() ?? [])]).toEqual(['To', 'Url']);
    expect(twilio.posted[0]?.get('Url')).toMatch(/Voice\/Template\/voice_text_to_speech$/);
    await twilio.pager.sms('+2000', 'high backend-api: Boom');
    expect(twilio.posted[1]?.get('Body')).toBe('sms_internal_alerts');
  });

  it('skips detection when it is off', async () => {
    const twilio = fakeTwilio(['queued', 'in-progress'], false);
    await twilio.pager.call('+2000', 'page');
    expect(twilio.posted[0]?.has('MachineDetection')).toBe(false);
    expect(twilio.statusChecks).toBe(1);
  });

  it('keeps waiting through a failed status check', async () => {
    const twilio = fakeTwilio(['queued', 'error', 'completed']);
    await twilio.pager.call('+2000', 'page');
    expect(twilio.statusChecks).toBe(2);
  });

  it('counts a call as placed when it is still ringing at the deadline', async () => {
    const twilio = fakeTwilio(['queued', ...Array<string>(20).fill('ringing')]);
    await twilio.pager.call('+2000', 'page');
    expect(twilio.statusChecks).toBe(5);
  });

  it('counts a call as placed when Twilio accepts it without a readable sid', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response('ok', { status: 201 }));
    const pager = new TwilioPager(creds, fetchFn);
    await expect(pager.call('+2', 'hi')).resolves.toBeUndefined();
  });

  it('throws when Twilio rejects the request', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response('nope', { status: 401 }));
    const pager = new TwilioPager(creds, fetchFn);
    await expect(pager.sms('+2', 'hi')).rejects.toThrow(/401/);
  });

  it('uses Twilio when the account and a number are set', () => {
    const pager = buildPager({
      ...testConfig,
      useFakeAdapters: false,
      notifyTo: ['+15550000001'],
      twilio: { ...creds, from: '+1000' },
    });
    expect(pager).toBeInstanceOf(TwilioPager);
    expect(buildPager(testConfig)).toBeInstanceOf(FakePager);
  });
});
