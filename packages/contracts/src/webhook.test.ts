import { describe, expect, it } from 'vitest';
import { posthogWebhookFixture } from './__fixtures__/index.ts';
import { roundTrip } from './test-utils.ts';
import { posthogWebhookSchema } from './webhook.ts';

describe('posthogWebhookSchema', () => {
  it('round-trips the fixture', () => {
    expect(roundTrip(posthogWebhookSchema, posthogWebhookFixture)).toEqual(posthogWebhookFixture);
  });

  it('passes through fields PostHog adds that ingest does not read', () => {
    const body = {
      ...posthogWebhookFixture,
      person: { id: 'p1' },
      event: {
        ...posthogWebhookFixture.event,
        distinct_id: 'u1',
        properties: { ...posthogWebhookFixture.event.properties, $lib: 'posthog-node' },
      },
    };
    expect(roundTrip(posthogWebhookSchema, body)).toEqual(body);
  });

  it('rejects a body without the issue id that becomes the fingerprint', () => {
    const properties = {
      ...posthogWebhookFixture.event.properties,
      $exception_issue_id: undefined,
    };
    const body = { event: { ...posthogWebhookFixture.event, properties } };
    expect(() => posthogWebhookSchema.parse(body)).toThrow();
  });

  it('rejects an event that is not an exception', () => {
    const body = { event: { ...posthogWebhookFixture.event, event: '$pageview' } };
    expect(() => posthogWebhookSchema.parse(body)).toThrow();
  });
});
