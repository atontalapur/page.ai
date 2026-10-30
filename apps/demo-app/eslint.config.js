import config from '@page/config/eslint';
import next from '@next/eslint-plugin-next';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  config,
  next.configs['core-web-vitals'],
  globalIgnores(['next-env.d.ts']),
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
);
