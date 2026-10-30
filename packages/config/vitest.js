import { configDefaults, defineConfig } from 'vitest/config';

const integration = ['src/**/*.int.test.{ts,tsx}'];

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
 * @param {{ coverage?: number }} [options] global coverage threshold in percent
 */
export function vitestConfig({ coverage = 70 } = {}) {
  return defineConfig({
    test: {
      passWithNoTests: true,
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
