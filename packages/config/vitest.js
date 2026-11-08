import process from 'node:process';
import { configDefaults, defineConfig } from 'vitest/config';

const integration = ['src/**/*.int.test.{ts,tsx}'];

// Vitest fails a run only if something failed, so a `-t` that matches no test exits 0 with
// every test skipped. The agent would read that as a pass (#66). This checks the whole run,
// so a file with every test skipped still passes if another file ran a test.
const failWhenNoTestRan = {
  onTestRunEnd(modules, _errors, reason) {
    if (reason !== 'passed' || modules.length === 0) return;
    const ran = modules.some((module) => !module.children.allTests('passed').next().done);
    if (ran) return;
    process.stderr.write('No tests ran: every test was skipped\n');
    process.exitCode = 1;
  },
};

// Tier and approval code decides what the agent may run, so it gets the toolkit bar
// wherever it lives, checked file by file. Glob thresholds don't inherit the global ones.
const strict = { lines: 90, functions: 90, branches: 90, statements: 90, perFile: true };

// A file or directory name where "tier" or "approval" starts a word: tier.ts, tiers/,
// TierPolicy.ts, execTier.ts, tool-tier.ts, exec.tier.ts, ApprovalGate/. Not frontier.ts.
const gated = '{{tier,approval}*,*{Tier,Approval}*,*[-_.]{tier,approval}*}';

/**
 * Unit tests run with `--project unit` and are coverage-gated. Integration tests
 * (`*.int.test.ts`) run with `--project integration` against a real Postgres.
 * Inline projects inherit the root `test` options (Vitest 5 default), so a package can
 * `mergeConfig(vitestConfig(), { test: { environment: 'jsdom' } })` and reach both.
 *
 * A run that matches no test files fails, and so does one where a `-t` skips every test, so
 * a mistyped filter can't read as a pass (#65, #66, #73). A package with no tests for a
 * project yet adds `--passWithNoTests` to that script, and drops it with its first test.
 * `pnpm test:guards` checks all of this per package in CI.
 *
 * Limits:
 * - A mistyped path still passes if another path in the same run matched, and a test renamed
 *   out of the include (`cart.spec.ts`) passes if other files still match.
 * - A path filter run across packages fails in any package that doesn't have the file.
 * - `--changed` with nothing affected exits 1, a clean tree included.
 * - `vitest related` turns the setting back on from the CLI, so it exits 0 with no match.
 * - `--shard` fails when there are more shards than test files.
 * - Vitest also fails a file with no tests in it, or a suite with none (`it.each([])`).
 *
 * @param {{ coverage?: number }} [options] global coverage threshold in percent
 */
export function vitestConfig({ coverage = 70 } = {}) {
  return defineConfig({
    test: {
      // Set, not left to the default: `--changed` turns it on when it's unset.
      passWithNoTests: false,
      // Spread the defaults so CI keeps its github-actions reporter. A CLI --reporter replaces
      // this list, so the toolkit policy refuses that flag for the agent.
      reporters: [...configDefaults.reporters, failWhenNoTestRan],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/**/test-utils.{ts,tsx}',
          'src/**/__fixtures__/**',
          'src/**/*.d.ts',
        ],
        thresholds: {
          lines: coverage,
          functions: coverage,
          branches: coverage,
          statements: coverage,
          // The named file itself, or everything under the named directory.
          [`src/**/${gated}{,/**}`]: strict,
        },
      },
      projects: [
        {
          test: {
            name: 'unit',
            include: ['src/**/*.test.{ts,tsx}'],
            exclude: [...configDefaults.exclude, ...integration],
          },
        },
        { test: { name: 'integration', include: integration } },
      ],
    },
  });
}
