import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

// V8's optimizing compiler needs over 1 GB to compile PGlite's wasm, which the agent
// sandbox (#5) doesn't have. The baseline compiler peaks near 700 MB and is no slower
// for these tests. Node rejects this flag in NODE_OPTIONS, so it goes here.
export default mergeConfig(vitestConfig(), { test: { execArgv: ['--liftoff-only'] } });
