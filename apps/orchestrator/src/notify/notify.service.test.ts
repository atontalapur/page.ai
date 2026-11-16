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

describe('TwilioPager', () => {
  it('posts the call and the SMS', async () => {
    const bodies: URLSearchParams[] = [];
    const fetchFn: typeof fetch = (_url, init) => {
      const body = init?.body;
      if (body instanceof URLSearchParams) bodies.push(body);
      else if (typeof body === 'string') bodies.push(new URLSearchParams(body));
      return Promise.resolve(new Response('{}', { status: 201 }));
    };
    const pager = new TwilioPager(
      { accountSid: 'AC123', authToken: 'tok', from: '+1000' },
      fetchFn,
    );
    await pager.call('+2000', 'high backend-api: Boom <x>');
    await pager.sms('+2000', 'high backend-api: Boom');
    expect(bodies[0]?.get('To')).toBe('+2000');
    expect(bodies[0]?.get('From')).toBe('+1000');
    expect(bodies[0]?.get('Twiml')).toContain('Boom');
    expect(bodies[0]?.get('Twiml')).not.toContain('<x>');
    expect(bodies[1]?.get('Body')).toContain('Boom');
  });

  it('throws when Twilio rejects the request', async () => {
    const fetchFn: typeof fetch = () => Promise.resolve(new Response('nope', { status: 401 }));
    const pager = new TwilioPager({ accountSid: 'AC', authToken: 't', from: '+1' }, fetchFn);
    await expect(pager.sms('+2', 'hi')).rejects.toThrow(/401/);
  });

  it('uses Twilio when the account and a number are set', () => {
    const pager = buildPager({
      ...testConfig,
      useFakeAdapters: false,
      notifyTo: ['+15550000001'],
      twilio: { accountSid: 'AC', authToken: 't', from: '+1000' },
    });
    expect(pager).toBeInstanceOf(TwilioPager);
    expect(buildPager(testConfig)).toBeInstanceOf(FakePager);
  });
});
