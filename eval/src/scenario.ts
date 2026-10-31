import { access, constants, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { type ScenarioMeta, scenarioMetaSchema } from '@page/contracts';

// The scripts run with `sh`, but are kept executable so they also run by hand.
const SCRIPTS = ['break.sh', 'trigger.sh', 'check.sh'] as const;
export const SCENARIO_FILES = [...SCRIPTS, 'reference_fix.patch', 'meta.json'] as const;

// Three digits then a kebab-case slug: 001-cart-total-off-by-one.
export const SCENARIO_ID = /^\d{3}(-[a-z0-9]+)+$/;

export interface Scenario {
  id: string;
  dir: string;
  meta: ScenarioMeta;
}

/** Every problem with one scenario directory, reported together. */
export class ScenarioError extends Error {
  constructor(
    readonly id: string,
    readonly problems: string[],
  ) {
    super(`scenario ${id}: ${problems.join('; ')}`);
    this.name = 'ScenarioError';
  }
}

/** Scenario directory names under `root`, sorted. Plain files (the README) are skipped. */
export async function listScenarioIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Checks a scenario directory's layout and parses its `meta.json`. */
export async function loadScenario(dir: string): Promise<Scenario> {
  const id = basename(dir);
  const problems: string[] = [];
  if (!SCENARIO_ID.test(id)) problems.push(`id must match ${SCENARIO_ID}`);

  for (const file of SCENARIO_FILES) {
    if (!(await exists(join(dir, file)))) problems.push(`missing ${file}`);
  }
  for (const script of SCRIPTS) {
    const path = join(dir, script);
    if ((await exists(path)) && !(await exists(path, constants.X_OK))) {
      problems.push(`${script} is not executable`);
    }
  }

  let meta: ScenarioMeta | undefined;
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    const parsed = scenarioMetaSchema.safeParse(raw);
    if (parsed.success) meta = parsed.data;
    else
      problems.push(
        ...parsed.error.issues.map((i) => `meta.json ${i.path.join('.')}: ${i.message}`),
      );
  } catch (err) {
    // A missing file is already reported above.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`meta.json: ${(err as Error).message}`);
    }
  }

  if (problems.length > 0 || !meta) throw new ScenarioError(id, problems);
  return { id, dir, meta };
}

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}
