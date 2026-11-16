import { SeverityNumber } from '@opentelemetry/api-logs';
import { after } from 'next/server';
import { posthogLogProvider } from '../instrumentation.ts';

// This logger is intentionally isolated: existing application logs remain on their current outputs.
const storefrontLogger = posthogLogProvider?.getLogger('storefront-outcomes');

/** Emits a structured operational outcome after a successful public storefront API mutation. */
export function logStorefrontOutcome(body: string, attributes: Record<string, number>): void {
  const provider = posthogLogProvider;
  if (!storefrontLogger || !provider) return;

  storefrontLogger.emit({
    body,
    severityNumber: SeverityNumber.INFO,
    attributes,
  });

  // Next runs this after the response, avoiding any delay to the successful mutation.
  after(() => provider.forceFlush().catch(() => undefined));
}
