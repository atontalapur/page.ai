// Usage: node scripts/pglite-snapshot.ts <dir>. Run by vitest.global-setup.ts in its own
// process so it can take the same node flags as the test workers.
import { writeSnapshots } from '../src/db/test-utils.ts';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/pglite-snapshot.ts <dir>');
  process.exit(2);
}
await writeSnapshots(dir);
