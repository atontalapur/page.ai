import { describe, expect, it } from 'vitest';
import { writePathRefusal } from './paths.ts';

describe('writePathRefusal', () => {
  it.each(['src/a.ts', './out.txt', '/workspace/README.md', '.gitignore', 'docs/.github-notes.md'])(
    'allows %j',
    (path) => {
      expect(writePathRefusal(path)).toBeNull();
    },
  );

  it.each([
    ['', 'empty path'],
    ['../x', 'uses ..'],
    ['src/../../x', 'uses ..'],
    ['apps/demo-app/x/../y.ts', 'uses ..'],
    // Textually inside the repo, but node_modules/@page/config is a symlink to
    // /workspace/packages/config, so sh lands in /tmp.
    ['apps/demo-app/node_modules/@page/config/../../../../../tmp/.gitconfig', 'uses ..'],
    ['/tmp/.gitconfig', 'outside the repo'],
    ['/workspace', 'outside the repo'],
    ['/workspace-evil/x', 'outside the repo'],
    ['.github/workflows/ci.yml', 'under .github/'],
    ['src/../.github/x', 'uses ..'],
    ['apps/demo-app/node_modules/@page/config/x', 'under node_modules/'],
    ['apps/demo-app/.github/x', 'under .github/'],
    ['.git/config', 'under .git/'],
    ['./.git/hooks/pre-commit', 'under .git/'],
  ])('refuses %j', (path, reason) => {
    expect(writePathRefusal(path)).toContain(reason);
  });
});
