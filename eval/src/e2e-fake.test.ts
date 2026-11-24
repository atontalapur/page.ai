import { join } from 'node:path';
import { posthogWebhookSchema, type PosthogWebhook } from '@page/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueTitleMatches, reportErrorLine } from './e2e.ts';
import { fakeTarget } from './e2e-fake.ts';
import { loadScenario, type Scenario } from './scenario.ts';
import { loadSplit } from './split.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const URL = 'http://orchestrator.test';
const SECRET = 'webhook-secret';
const signal = new AbortController().signal;

const scenario = (kind: Scenario['kind'] = 'code'): Scenario => ({
  id: '001-bad-currency-code',
  dir: 'scenarios/001-bad-currency-code',
  kind,
  meta: {
    class: 'frontend',
    expectedTier: 1,
    description: 'd',
    report:
      'GET / returned 500\n\nRangeError: Invalid currency code : US\n    at new NumberFormat (<anonymous>)',
  },
});

interface Sent {
  url: string;
  init: RequestInit;
  body: PosthogWebhook;
}

/** Stubs fetch with the orchestrator's answer and keeps every request it gets. */
function orchestrator(status = 200, created = true): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    sent.push({ url, init, body: posthogWebhookSchema.parse(JSON.parse(init.body as string)) });
    const body = status === 200 ? JSON.stringify({ issue: { id: 'issue-1' }, created }) : 'no';
    return Promise.resolve(new Response(body, { status }));
  });
  return sent;
}

/** ingest's titleFrom: the first exception's type and value joined by ': '. */
const titleOf = ({ event: { properties: p } }: PosthogWebhook) =>
  [p.$exception_types?.[0], p.$exception_values?.[0]].filter((part) => !!part?.trim()).join(': ');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fakeTarget', () => {
  const target = fakeTarget({ orchestratorUrl: URL, webhookSecret: SECRET });

  it("posts the scenario's report to /ingest/posthog with the webhook secret", async () => {
    const sent = orchestrator();
    const line = await target.trigger(scenario(), signal);

    expect(sent).toHaveLength(1);
    const [{ url, init, body }] = sent as [Sent];
    expect(url).toBe(`${URL}/ingest/posthog`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${SECRET}` });
    expect(init.signal).toBe(signal);
    expect(titleOf(body)).toBe('RangeError: Invalid currency code : US');
    expect(body.event.properties).toMatchObject({ method: 'GET', path: '/', route: '/' });
    expect(line).toBe(
      `sent 001-bad-currency-code's report as webhook ${body.event.uuid}: issue issue-1 (new)`,
    );
  });

  it('gives each webhook its own uuid and PostHog issue id, so each run opens its own issue', async () => {
    const sent = orchestrator(200, false);
    await target.trigger(scenario(), signal);
    const line = await target.trigger(scenario(), signal);

    const [first, second] = sent.map((s) => s.body.event) as [
      PosthogWebhook['event'],
      PosthogWebhook['event'],
    ];
    expect(first.uuid).not.toBe(second.uuid);
    expect(first.properties.$exception_issue_id).toBe(`fake-001-bad-currency-code-${first.uuid}`);
    expect(second.properties.$exception_issue_id).toBe(`fake-001-bad-currency-code-${second.uuid}`);
    expect(line).toMatch(/\(repeat\)$/);
  });

  it('fails the trigger when the orchestrator refuses the webhook', async () => {
    orchestrator(401);
    await expect(target.trigger(scenario(), signal)).rejects.toThrow(
      'POST /ingest/posthog returned 401: no',
    );
  });

  it('seeds and unseeds a code scenario without touching anything', async () => {
    const sent = orchestrator();
    await target.seed(scenario(), signal);
    await target.unseed(scenario(), signal);
    expect(sent).toEqual([]);
  });

  it('refuses an ops scenario, which needs a demo app to break', async () => {
    await expect(target.seed(scenario('ops'), signal)).rejects.toThrow(
      '001-bad-currency-code is an ops scenario; the fake target has no demo app to break',
    );
  });

  // The harness only follows an issue titled like the report's error line, so every dev code
  // scenario's webhook has to produce that title, or the run waits out the issue step.
  it("titles each dev code scenario's issue with the report's error line", async () => {
    const sent = orchestrator();
    const mismatched: string[] = [];
    for (const id of (await loadSplit(join(ROOT, 'eval', 'split.json'))).dev) {
      const s = await loadScenario(join(ROOT, 'scenarios', id));
      if (s.kind === 'ops') continue;
      await target.trigger(s, signal);
      const title = titleOf(sent.at(-1)!.body);
      const line = reportErrorLine(s.meta.report);
      if (line === null || !issueTitleMatches(title, line)) {
        mismatched.push(`${id}: ${JSON.stringify(title)}`);
      }
    }
    expect(mismatched).toEqual([]);
    expect(sent.length).toBeGreaterThan(10);
  });
});
