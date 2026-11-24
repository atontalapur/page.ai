import { mergeConfig } from 'vitest/config';
import { vitestConfig } from '@page/config/vitest';

export default mergeConfig(
  vitestConfig({ coverage: { statements: 79, branches: 73, functions: 88, lines: 79 } }),
  {
    test: {
      coverage: {
        exclude: ['src/main.tsx'],
      },
    },
  },
);
