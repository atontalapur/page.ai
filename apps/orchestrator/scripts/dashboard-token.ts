// Usage: pnpm --filter @page/orchestrator dashboard-token <name>
// Makes a personal dashboard token for one person. Prints the token, to hand to them once,
// and the `name:sha256` entry to add to the orchestrator's DASHBOARD_TOKENS. Only the entry
// is configured; nothing keeps the token, so a lost one is replaced with a new one.
import process from 'node:process';
import { newDashboardToken } from '../src/auth/dashboard-tokens.ts';

const USAGE = 'usage: pnpm --filter @page/orchestrator dashboard-token <name>';

// pnpm passes a `--` through.
const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}

try {
  const { name, token, entry } = newDashboardToken(args[0]!);
  console.log(
    [
      `Token for ${name}. Give it to them once; it is not stored anywhere:`,
      '',
      `  ${token}`,
      '',
      'Add this entry to DASHBOARD_TOKENS (comma-separated, one entry per person):',
      '',
      `  ${entry}`,
    ].join('\n'),
  );
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(2);
}
