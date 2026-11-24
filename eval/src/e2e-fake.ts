// The end-to-end test's `fake` target (#211): no demo app, for CI, where the orchestrator and
// the node daemon both run with USE_FAKE_ADAPTERS. The run still covers ingest, triage, the fix
// job, the daemon's run and its outcome, with no PostHog, Docker, GitHub or model.
import { randomUUID } from 'node:crypto';
import { webhookFor } from '@page/contracts/fixtures';
import type { Target } from './e2e.ts';

export interface FakeTargetOptions {
  /** The orchestrator's base URL, no trailing slash. */
  orchestratorUrl: string;
  /** The orchestrator's POSTHOG_WEBHOOK_SECRET, sent as the bearer `/ingest/posthog` checks. */
  webhookSecret: string;
}

/**
 * Seeding does nothing. The trigger sends the scenario's report to the orchestrator as the
 * `$exception` webhook the demo app's error would send (webhookFor), with a PostHog issue id of
 * its own, so a second run opens a new issue instead of counting another occurrence of the
 * first. An ops scenario needs a demo app to break, so the fake target can't play one.
 */
export function fakeTarget(options: FakeTargetOptions): Target {
  return {
    name: 'fake',
    seed(s) {
      if (s.kind === 'ops') {
        return Promise.reject(
          new Error(`${s.id} is an ops scenario; the fake target has no demo app to break`),
        );
      }
      return Promise.resolve();
    },
    async trigger(s, signal) {
      const id = randomUUID();
      const body = webhookFor(s.meta.report, 'source', {
        event: {
          uuid: id,
          event: '$exception',
          timestamp: new Date().toISOString(),
          properties: { $exception_issue_id: `fake-${s.id}-${id}` },
        },
      });
      const res = await fetch(`${options.orchestratorUrl}/ingest/posthog`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.webhookSecret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`POST /ingest/posthog returned ${res.status}: ${text.slice(0, 200)}`);
      }
      const { issue, created } = JSON.parse(text) as { issue: { id: string }; created: boolean };
      return `sent ${s.id}'s report as webhook ${id}: issue ${issue.id} (${created ? 'new' : 'repeat'})`;
    },
    unseed: () => Promise.resolve(),
  };
}
