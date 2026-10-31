import type { NextConfig } from 'next';

// Seeded bugs have to reproduce the same way on every request, so keep the
// classic rendering and prefetch model instead of Cache Components.
const nextConfig: NextConfig = {
  cacheComponents: false,
  partialPrefetching: false,
};

export default nextConfig;
