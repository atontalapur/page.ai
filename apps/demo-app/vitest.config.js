import process from 'node:process';
import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

// Coverage keeps the shared 70, not one point under main like the other packages (#210). The
// agent runs this package's `test` in the sandbox with coverage on, so a tight minimum would
// fail a correct fix that adds an untested branch, and change its confidence and the eval.
export default mergeConfig(vitestConfig(), {
  test: {
    // V8's optimizing compiler needs over 1 GB to compile PGlite's wasm, which the agent
    // sandbox (#5) doesn't have, so the sandbox image sets PAGE_SANDBOX and tests there
    // use the baseline compiler (peaks near 700 MB). Node rejects this flag in
    // NODE_OPTIONS, so it goes here.
    execArgv: process.env.PAGE_SANDBOX ? ['--liftoff-only'] : [],
    globalSetup: ['vitest.global-setup.ts'],
    // The first PGlite test in each file compiles the wasm and boots Postgres, which took
    // 1.6-5.8s in CI with other turbo tasks running beside it (#62).
    testTimeout: 15_000,
  },
});
