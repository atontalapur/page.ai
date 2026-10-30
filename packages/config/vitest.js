import { configDefaults, defineConfig } from 'vitest/config';

const integration = ['src/**/*.int.test.{ts,tsx}'];

// Tier and approval code decides what the agent may run, so it gets the toolkit bar
// wherever it lives. Glob thresholds don't inherit the global ones.
const strict = { lines: 90, functions: 90, branches: 90, statements: 90 };

/**
 * Unit tests run with `--project unit` and are coverage-gated. Integration tests
 * (`*.int.test.ts`) run with `--project integration` against a real Postgres.
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
        exclude: ['src/**/*.test.{ts,tsx}'],
        thresholds: {
          lines: coverage,
          functions: coverage,
          branches: coverage,
          statements: coverage,
          'src/**/*{tier,approval}*/**': strict,
          'src/**/*{tier,approval}*.{ts,tsx}': strict,
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
