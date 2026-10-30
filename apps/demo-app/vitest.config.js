import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(vitestConfig(), {
  test: {
    // V8's optimizing compiler needs over 1 GB to compile PGlite's wasm, which the agent
    // sandbox (#5) doesn't have. The baseline compiler peaks near 700 MB and is no slower
    // for these tests. Node rejects this flag in NODE_OPTIONS, so it goes here.
    execArgv: ['--liftoff-only'],
    // The first test in a file builds the PGlite snapshot (see src/db/test-utils.ts),
    // which takes about 4 s on the sandbox's one CPU. Later tests take under 1 s.
    testTimeout: 15_000,
  },
});
