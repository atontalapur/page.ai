// Checks that every package's test runs fail when no test ran (#65, #66, #73, #78).
//
// For each package that runs vitest, and each of its `unit` and `integration` projects:
// - a path filter that matches no file must exit 1 with "No test files found"
// - a `-t` that matches no test must exit 1 with the shared reporter's message, when the
//   project has unit test files (integration files need Postgres to collect)
// - a script that passes `--passWithNoTests` must have no test files behind it
//
// This runs vitest the way the package's config resolves it, so a package that turns the
// guard off with `mergeConfig` fails here too. Run from the repo root.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

const ROOTS = ['apps', 'packages'];
const SCRIPTS = { unit: 'test', integration: 'test:integration' };
const NO_FILE = 'zz-no-such-test-file.test.ts';
const NO_NAME = 'zz no test has this name';
// Each check starts vitest, and the demo app's boots PGlite. The checks are CPU-bound, so
// more than one per core doesn't help, and 4 (the CI runner's cores) keeps memory in bounds.
const SLOTS = Math.min(availableParallelism(), 4);

function packages() {
  const dirs = ROOTS.flatMap((root) => readdirSync(root).map((name) => join(root, name)));
  dirs.push('eval');
  return dirs.filter((dir) => {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) return false;
    const { scripts = {} } = JSON.parse(readFileSync(file, 'utf8'));
    return /\bvitest\b/.test(scripts.test ?? '');
  });
}

// Runs at most SLOTS tasks at once, in the order they were queued.
let running = 0;
const waiting = [];
async function slot(task) {
  if (running >= SLOTS) await new Promise((wake) => waiting.push(wake));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

// The package's own vitest, started with node: `pnpm exec` costs a process per check.
function vitest(cwd, args) {
  const require = createRequire(resolve(cwd, 'package.json'));
  const manifest = require.resolve('vitest/package.json');
  const bin = join(dirname(manifest), require(manifest).bin.vitest);
  return slot(
    () =>
      new Promise((done) => {
        const child = spawn(process.execPath, [bin, ...args], {
          cwd,
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (output += chunk));
        child.on('close', (status) => done({ status, output }));
      }),
  );
}

async function checkProject(dir, project, script, files) {
  const failures = [];
  if (script !== undefined && /--passWithNoTests\b/.test(script) && files.length > 0) {
    failures.push(
      `${dir}: drop --passWithNoTests from its ${SCRIPTS[project]} script, ` +
        `the ${project} project has ${files.length} test files`,
    );
  }

  const noFile = vitest(dir, ['run', '--project', project, NO_FILE]);
  // One file is enough: the config and reporter are the same for every file, and
  // importing all of them takes the orchestrator over 10s.
  const noName =
    project === 'unit' && files.length > 0
      ? vitest(dir, ['run', '--project', project, '-t', NO_NAME, files[0]])
      : undefined;

  const { status, output } = await noFile;
  if (status !== 1 || !output.includes('No test files found')) {
    failures.push(`${dir} ${project}: a path that matches no file exited ${status}\n${output}`);
  }
  if (noName !== undefined) {
    const { status, output } = await noName;
    if (status !== 1 || !output.includes('No tests ran')) {
      failures.push(`${dir} ${project}: a -t that matches no test exited ${status}\n${output}`);
    }
  }
  return failures;
}

// A package that can't be checked (no vitest to resolve, unreadable list output) is a
// failure of that package, reported with the rest, not a crash that hides them.
async function checkPackage(dir) {
  try {
    return await checkPackageOrThrow(dir);
  } catch (error) {
    return [`${dir}: couldn't run the checks: ${error instanceof Error ? error.message : error}`];
  }
}

async function checkPackageOrThrow(dir) {
  const { scripts } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  // One list covers both projects; each entry names its project.
  const listed = await vitest(dir, ['list', '--filesOnly', '--json']);
  if (listed.status !== 0) return [`${dir}: vitest list failed\n${listed.output}`];
  const entries = JSON.parse(listed.output.slice(listed.output.indexOf('[')));
  const results = await Promise.all(
    Object.entries(SCRIPTS).map(([project, name]) => {
      const files = entries.filter((e) => e.projectName === project).map((e) => e.file);
      return checkProject(dir, project, scripts[name], files);
    }),
  );
  return results.flat();
}

const dirs = packages();
// Failures print in package order, not in the order the checks finish.
const failures = (await Promise.all(dirs.map(checkPackage))).flat();

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`test guards hold in ${dirs.length} packages\n`);
}
