import posthog from 'posthog-js';
import { configureClientReporting, setServerRenderFailed } from './observability/client.ts';

// Runs before hydration, so an error in the first render is reported too. The browser
// can't read runtime env: next.config.ts inlines these values at build time.
const token = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if (token && host) {
  posthog.init(token, {
    api_host: host,
    defaults: '2026-08-30',
    capture_exceptions: true,
    debug: process.env.NODE_ENV === 'development',
  });
  configureClientReporting(
    {
      key: token,
      host,
      release: process.env.NEXT_PUBLIC_RELEASE ?? 'dev',
    },
    posthog,
  );
} else if (process.env.NODE_ENV === 'development') {
  const missingVariable = token ? 'NEXT_PUBLIC_POSTHOG_HOST' : 'NEXT_PUBLIC_POSTHOG_KEY';
  console.error(
    new Error(
      `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
    ),
  );
}

// Next sets this id when server rendering failed and the page falls back to a client
// render. onRequestError already reported that error, so the same throw on the client
// would be a duplicate. React drops the id once it renders, so read it here.
setServerRenderFailed(document.documentElement.id === '__next_error__');

export function onRouterTransitionStart(): void {
  // The next route renders on the client only, so its errors haven't been reported.
  setServerRenderFailed(false);
}
