import { z } from 'zod';
import { fingerprintSchema } from './common.ts';

/**
 * Body of the PostHog webhook destination for `$exception` events (#29), sent with
 * PostHog's default `{ event, person }` template. PostHog owns this shape, so only the
 * fields ingest reads are checked and everything else passes through.
 */
export const posthogWebhookSchema = z.looseObject({
  event: z.looseObject({
    uuid: z.string().min(1),
    event: z.literal('$exception'),
    timestamp: z.iso.datetime({ offset: true }),
    properties: z.looseObject({
      // The error-tracking issue PostHog grouped this exception into.
      $exception_issue_id: fingerprintSchema,
      $exception_types: z.array(z.string()).optional(),
      $exception_values: z.array(z.string()).optional(),
    }),
  }),
});

export type PosthogWebhook = z.infer<typeof posthogWebhookSchema>;
