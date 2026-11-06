import { defineConfig, globalIgnores } from 'eslint/config';
import config from './eslint.js';

// This package has no tsconfig of its own for the type-aware rules to read the file with.
export default defineConfig(globalIgnores(['vitest.d.ts']), config);
