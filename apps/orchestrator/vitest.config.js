import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

// Nest's decorators read and write Reflect metadata, so load the polyfill before any test.
export default mergeConfig(
  vitestConfig({ coverage: { statements: 85, branches: 77, functions: 86, lines: 86 } }),
  { test: { setupFiles: ['reflect-metadata'] } },
);
