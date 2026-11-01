import config from '@page/config/eslint';
import { defineConfig } from 'eslint/config';

export default defineConfig(
  config,
  {
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // Vendored from the shadcn registry and overwritten by `shadcn add --overwrite`, so
    // loosen the rules recharts' loosely typed payloads trip instead of patching the file.
    files: ['src/components/ui/chart.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
