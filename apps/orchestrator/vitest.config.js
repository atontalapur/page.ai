import { vitestConfig } from '@page/config/vitest';
import { mergeConfig } from 'vitest/config';

// Nest's decorators read and write Reflect metadata, so load the polyfill before any test.
export default mergeConfig(vitestConfig(), { test: { setupFiles: ['reflect-metadata'] } });
