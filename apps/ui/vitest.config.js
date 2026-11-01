import { mergeConfig } from 'vitest/config';
import { vitestConfig } from '@page/config/vitest';

export default mergeConfig(vitestConfig(), {
  test: {
    coverage: {
      exclude: ['src/main.tsx'],
    },
  },
});
