import { vitestConfig } from '@page/config/vitest';

export default vitestConfig({
  coverage: { statements: 99, branches: 99, functions: 99, lines: 99 },
});
