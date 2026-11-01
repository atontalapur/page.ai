import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TestProject } from 'vitest/node';

// Builds the PGlite snapshots unit tests load (see writeSnapshots in src/db/test-utils.ts).
// It runs in a child process with the workers' execArgv: Vitest's own process can't take
// --liftoff-only, and without it PGlite can't start in the 1 GB sandbox. The files go
// under node_modules/.cache, not /tmp, which is a small tmpfs in the sandbox.
// Defined on the root config, so it runs once per Vitest run with the root project.
// Integration runs (`--project integration`) don't load PGlite, so they skip it.
export default async function setup(project: TestProject) {
  if (!project.vitest.projects.some((p) => p.name === 'unit')) return;
  const cache = join(import.meta.dirname, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'pglite-'));
  await promisify(execFile)(process.execPath, [
    ...project.config.execArgv,
    join(import.meta.dirname, 'scripts/pglite-snapshot.ts'),
    dir,
  ]);
  project.provide('pgliteSnapshotDir', dir);
  return () => rm(dir, { recursive: true, force: true });
}
