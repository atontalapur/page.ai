import type { NextConfig } from 'next';
import { browserReportingEnv } from './src/observability/config.ts';

// Seeded bugs have to reproduce the same way on every request, so keep the
// classic rendering and prefetch model instead of Cache Components.
const nextConfig: NextConfig = {
  cacheComponents: false,
  partialPrefetching: false,
  // Browser error reporting. Inlined at build time, unlike the server's runtime POSTHOG_*.
  env: browserReportingEnv(),
};

export default nextConfig;
