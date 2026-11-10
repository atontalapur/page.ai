import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Config } from '../config.ts';
import { testConfig } from '../db/test-utils.ts';
import { NotifyService } from './notify.service.ts';
import { buildPager, FakePager, TwilioPager } from './pager.ts';

const logger = pino({ enabled: false });

function service(pager: FakePager, notifyTo = ['+15551110000']) {
  const config: Config = { ...testConfig, notifyTo };
  return new NotifyService(pager, config, logger);
}

describe('NotifyService', () => {
  it('calls and then texts', async () => {
    const pager = new FakePager();
    await service(pager).deliver(
      { v: 1, issueId: '00000000-0000-4000-8000-000000000001', channel: 'call', message: 'page' },
      { retryCount: 0, retryLimit: 3 },
    );
    expect(pager.calls).toEqual([{ to: '+15551110000', message: 'page' }]);
    expect(pager.texts).toEqual([{ to: '+15551110000', message: 'page' }]);
  });

  it('retries a failed call without sending SMS yet', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    await expect(
      service(pager).deliver(
        { v: 1, issueId: '00000000-0000-4000-8000-000000000001', channel: 'call', message: 'page' },
        { retryCount: 0, retryLimit: 3 },
      ),
    ).rejects.toThrow('call failed');
    expect(pager.texts).toEqual([]);
  });

  it('sends SMS when the last call attempt fails', async () => {
    const pager = new FakePager();
    pager.failCalls = 1;
    await service(pager).deliver(
      { v: 1, issueId: '00000000-0000-4000-8000-000000000001', channel: 'call', message: 'page' },
      { retryCount: 3, retryLimit: 3 },
    );
    expect(pager.calls).toEqual([]);
    expect(pager.texts).toEqual([{ to: '+15551110000', message: 'page' }]);
  });

  it('does nothing when no numbers are configured', async () => {
    const pager = new FakePager();
    await service(pager, []).deliver(
      { v: 1, issueId: '00000000-0000-4000-8000-000000000001', channel: 'call', message: 'page' },
      { retryCount: 0, retryLimit: 3 },
    );
    expect(pager.calls).toEqual([]);
    expect(pager.texts).toEqual([]);
  });

  it('sends only SMS when the job says so', async () => {
    const pager = new FakePager();
    await service(pager).deliver(
      { v: 1, issueId: '00000000-0000-4000-8000-000000000001', channel: 'sms', message: 'page' },
      { retryCount: 0, retryLimit: 3 },
    );
    expect(pager.calls).toEqual([]);
    expect(pager.texts).toEqual([{ to: '+15551110000', message: 'page' }]);
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
