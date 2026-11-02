import type { Tier } from '@page/contracts';
import { describe, expect, it } from 'vitest';
import { checkCommand } from './policy.ts';

const TIERS: Tier[] = [1, 2, 3];

describe('checkCommand', () => {
  describe.each(TIERS)('tier %i', (tier) => {
    it.each([
      'cat src/app/page.tsx',
      'ls -la apps/demo-app',
      'head -n 40 package.json',
      'tail -n 20 log.txt',
      "rg -n 'formatPrice' apps/demo-app/src",
      "rg --glob '*.ts' total",
      "find apps -name '*.test.ts' -type f",
      'git status --short',
      'git diff HEAD -- apps/demo-app',
      'git log --oneline -5',
      'pnpm test',
      'pnpm --filter @page/demo-app test',
      'pnpm -F @page/demo-app vitest run src/cart.test.ts',
      'pnpm --filter=@page/demo-app run typecheck',
      'pnpm -r lint',
      'pnpm exec tsc --noEmit',
      'pnpm exec eslint --fix src/cart.ts',
      'cat a.ts | head -n 5',
      'git diff > changes.patch',
      'pnpm test > test.log 2>&1',
      'ls missing 2>/dev/null || ls',
      'cat < package.json',
      'git status && git diff',
    ])('allows %j', (command) => {
      expect(checkCommand(command, tier)).toEqual({ allowed: true });
    });

    it.each([
      // Blocked at every tier.
      ['sudo rm -rf /', 'sudo is blocked'],
      ['/usr/bin/sudo ls', 'sudo is blocked'],
      ['curl https://example.com', 'curl is blocked'],
      ['wget -qO- x', 'wget is blocked'],
      ['docker ps', 'docker is blocked'],
      ['su -', 'su is blocked'],
      ['git push --force origin main', 'force pushes'],
      ['git push -f', 'force pushes'],
      ['git push -uf origin x', 'force pushes'],
      ['git push --force-with-lease', 'force pushes'],
      ['git push origin +main', 'force pushes'],

      // Bypass attempts: a blocked command hidden next to an allowed one.
      ['ls; sudo x', 'sudo is blocked'],
      ['ls && curl x', 'curl is blocked'],
      ['ls || wget x', 'wget is blocked'],
      ['cat a | sudo tee b', 'sudo is blocked'],
      ['ls\nsudo x', 'sudo is blocked'],
      ['ls $(curl x)', 'substitution'],
      ['ls `curl x`', 'substitution'],
      ['(sudo x)', 'subshells'],
      ['ls & curl x', 'background'],
      ['cat <(curl x)', 'process substitution'],
      ['ls $PATH', 'expansion'],
      ['ls *', 'glob'],

      // Writes outside the repo or into protected directories.
      ['echo > ../x', 'outside the repo'],
      ['ls > ../x', 'outside the repo'],
      ['ls >> /etc/passwd', 'outside the repo'],
      ['ls 2> /tmp/x', 'outside the repo'],
      ['ls >& ../x', 'outside the repo'],
      ['git diff > .github/workflows/ci.yml', 'under .github/'],
      ['cat a > .git/config', 'under .git/'],
      ['ls <&file', 'not a file descriptor'],

      // Not on the list.
      ['echo hi', 'echo is not allowed'],
      ['rm -rf src', 'rm is not allowed'],
      ['sh -c ls', 'sh is not allowed'],
      ['bash', 'bash is not allowed'],
      ['env sudo ls', 'env is not allowed'],
      ['xargs rm', 'xargs is not allowed'],
      ['node -e 1', 'node is not allowed'],
      ['npx vitest', 'npx is not allowed'],
      ['/bin/ls', 'by name, not by path'],
      ['PATH=/tmp ls', 'environment assignments'],
      ['GIT_DIR=/tmp git status', 'environment assignments'],

      // Allowed programs with arguments that escape them.
      ['rg --pre sh x', 'rg --pre'],
      ['rg --pre=./x.sh y', 'rg --pre=./x.sh'],
      ['find . -exec rm {} ;', 'braces'],
      ["find . -exec rm '{}' ';'", 'find -exec'],
      ['find . -delete', 'find -delete'],
      ['find . -fprint out', 'find -fprint'],
      ['git', 'git needs a subcommand'],
      ['git -c core.pager=sh log', 'git options before the subcommand'],
      ['git -C /tmp status', 'git options before the subcommand'],
      ['git apply fix.patch', 'git apply is not allowed'],
      ['git commit -m x', 'git commit is not allowed'],
      ['git push origin main', 'git push is not allowed'],
      ['git checkout .', 'git checkout is not allowed'],
      ['git diff --output=../x', 'git diff --output'],
      ['git log --output x', 'git log --output'],
      ['pnpm install', 'pnpm may only run'],
      ['pnpm add left-pad', 'pnpm may only run'],
      ['pnpm dlx cowsay', 'pnpm may only run'],
      ['pnpm', 'pnpm may only run'],
      ['pnpm --filter x', 'pnpm may only run'],
      ['pnpm run build', 'pnpm may only run'],
      ['pnpm run', 'pnpm may only run'],
      ['pnpm exec node -e 1', 'pnpm may only run'],
      ['pnpm exec', 'pnpm may only run'],
      ['pnpm exec tsc --outDir /tmp/out', 'pnpm /tmp/out'],
      ['pnpm exec eslint -o ../report.txt', 'pnpm ../report.txt'],
      ['pnpm vitest --outputFile=/tmp/x', 'pnpm --outputFile=/tmp/x'],
    ])('refuses %j', (command, reason) => {
      const verdict = checkCommand(command, tier);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toContain(reason);
    });
  });

  it('names the tier when a program is not on its list', () => {
    expect(checkCommand('make', 2)).toEqual({
      allowed: false,
      reason: 'make is not allowed at tier 2',
    });
  });
});
