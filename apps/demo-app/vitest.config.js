import process from 'node:process';
import { vitestConfig } from '@page/config/vitest';
import { configDefaults, mergeConfig } from 'vitest/config';

// Vitest fails a run only if something failed, so a `-t` that matches no test exits 0 with
// every test skipped. The agent would read that as a pass (#66).
const failWhenNoTestRan = {
  onTestRunEnd(modules, _errors, reason) {
    if (reason !== 'passed' || modules.length === 0) return;
    const ran = modules.some((module) =>
      [...module.children.allTests()].some((test) =>
        ['passed', 'failed'].includes(test.result().state),
      ),
    );
    if (ran) return;
    process.stderr.write('No tests ran: every test was skipped\n');
    process.exitCode = 1;
  },
};

export default mergeConfig(vitestConfig(), {
  test: {
    // Spread the defaults so CI keeps its github-actions reporter.
    reporters: [...configDefaults.reporters, failWhenNoTestRan],
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
