import { initClientReporting, setServerRenderFailed } from './observability/client.ts';

// Runs before hydration, so an error in the first render is reported too. The browser
// can't read runtime env: next.config.ts inlines these values at build time.
try {
  initClientReporting({
    key: process.env.NEXT_PUBLIC_POSTHOG_KEY || undefined,
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '',
    release: process.env.NEXT_PUBLIC_RELEASE ?? 'dev',
  });
} catch (err) {
  console.error('Error reporting failed to start', err);
}

// Next sets this id when server rendering failed and the page falls back to a client
// render. onRequestError already reported that error, so the same throw on the client
// would be a duplicate. React drops the id once it renders, so read it here.
setServerRenderFailed(document.documentElement.id === '__next_error__');

export function onRouterTransitionStart(): void {
  // The next route renders on the client only, so its errors haven't been reported.
  setServerRenderFailed(false);
}
