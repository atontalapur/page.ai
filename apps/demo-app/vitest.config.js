import process from 'node:process';
import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(vitestConfig(), {
  test: {
    // V8's optimizing compiler needs over 1 GB to compile PGlite's wasm, which the agent
    // sandbox (#5) doesn't have, so the sandbox image sets PAGE_SANDBOX and tests there
    // use the baseline compiler (peaks near 700 MB). Node rejects this flag in
    // NODE_OPTIONS, so it goes here.
    execArgv: process.env.PAGE_SANDBOX ? ['--liftoff-only'] : [],
    globalSetup: ['vitest.global-setup.ts'],
    // This app has tests, so a filter that matches none is a mistake. The agent would
    // read the shared config's exit 0 as a pass (#65).
    passWithNoTests: false,
    // The first PGlite test in each file compiles the wasm and boots Postgres, which took
    // 1.6-5.8s in CI with other turbo tasks running beside it (#62).
    testTimeout: 15_000,
  },
});
