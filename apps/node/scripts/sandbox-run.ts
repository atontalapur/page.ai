// Usage: node scripts/sandbox-run.ts <image> [name]
// Starts a sandbox the way the daemon will and prints its name. Run commands in it with
// `docker exec <name> ...`; stop it early with `docker stop <name>`.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sandboxRunArgs } from '../src/sandbox/run-args.ts';

const [image, name = `sandbox-${randomUUID().slice(0, 8)}`] = process.argv.slice(2);
if (!image) {
  console.error('usage: node scripts/sandbox-run.ts <image> [name]');
  process.exit(2);
}

execFileSync('docker', sandboxRunArgs({ image, name }), { stdio: ['ignore', 'ignore', 'inherit'] });
console.log(name);
