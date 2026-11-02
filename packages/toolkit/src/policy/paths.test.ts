import { describe, expect, it } from 'vitest';
import { writePathRefusal } from './paths.ts';

describe('writePathRefusal', () => {
  it.each([
    'src/a.ts',
    './out.txt',
    'apps/demo-app/x/../y.ts',
    '/workspace/README.md',
    '.gitignore',
    'docs/.github-notes.md',
  ])('allows %j', (path) => {
    expect(writePathRefusal(path)).toBeNull();
  });

  it.each([
    ['', 'empty path'],
    ['../x', 'outside the repo'],
    ['src/../../x', 'outside the repo'],
    ['/tmp/.gitconfig', 'outside the repo'],
    ['/workspace', 'outside the repo'],
    ['/workspace-evil/x', 'outside the repo'],
    ['.github/workflows/ci.yml', 'under .github/'],
    ['src/../.github/x', 'under .github/'],
    ['apps/demo-app/.github/x', 'under .github/'],
    ['.git/config', 'under .git/'],
    ['./.git/hooks/pre-commit', 'under .git/'],
  ])('refuses %j', (path, reason) => {
    expect(writePathRefusal(path)).toContain(reason);
  });
});
