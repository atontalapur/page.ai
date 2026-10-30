import config from '@page/config/eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(config, {
  languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
});
