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
import { join } from 'node:path';
import process from 'node:process';

const ROOTS = ['apps', 'packages'];
const SCRIPTS = { unit: 'test', integration: 'test:integration' };
const NO_FILE = 'zz-no-such-test-file.test.ts';
const NO_NAME = 'zz no test has this name';

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

function vitest(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['exec', 'vitest', ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (status) => resolve({ status, output }));
  });
}

async function checkProject(dir, project, script) {
  const failures = [];
  const listed = await vitest(dir, ['list', '--project', project, '--filesOnly', '--json']);
  if (listed.status !== 0) return [`${dir} ${project}: vitest list failed\n${listed.output}`];
  const files = JSON.parse(listed.output.slice(listed.output.indexOf('[')));

  if (script !== undefined && /--passWithNoTests\b/.test(script) && files.length > 0) {
    failures.push(
      `${dir}: drop --passWithNoTests from its ${SCRIPTS[project]} script, ` +
        `the ${project} project has ${files.length} test files`,
    );
  }

  const noFile = await vitest(dir, ['run', '--project', project, NO_FILE]);
  if (noFile.status !== 1 || !noFile.output.includes('No test files found')) {
    failures.push(`${dir} ${project}: a path that matches no file exited ${noFile.status}`);
  }

  if (project === 'unit' && files.length > 0) {
    const noName = await vitest(dir, ['run', '--project', project, '-t', NO_NAME]);
    if (noName.status !== 1 || !noName.output.includes('No tests ran')) {
      failures.push(`${dir} ${project}: a -t that matches no test exited ${noName.status}`);
    }
  }
  return failures;
}

const queue = packages().flatMap((dir) => {
  const { scripts } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return Object.entries(SCRIPTS).map(
    ([project, name]) =>
      () =>
        checkProject(dir, project, scripts[name]),
  );
});
const total = queue.length;
// A few at a time: each check starts vitest, and the demo app's boots PGlite.
const failures = [];
async function worker() {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    failures.push(...(await next()));
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`test guards hold in ${total / 2} packages\n`);
}
