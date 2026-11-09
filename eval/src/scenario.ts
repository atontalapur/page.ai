import { access, constants, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type ScenarioKind,
  scenarioKind,
  type ScenarioMeta,
  scenarioMetaSchema,
} from '@page/contracts';

// The scripts run with `sh`, but are kept executable so they also run by hand.
// A code scenario breaks the source in the sandbox and a patch fixes it. An ops scenario
// (Tier 3) breaks a live demo app and an ops action fixes it, so it has no patch, and its
// check runs on the host against $DEMO_APP_URL.
export const SCENARIO_SCRIPTS = {
  code: ['break.sh', 'trigger.sh', 'check.sh'],
  ops: ['break-ops.sh', 'fix-ops.sh', 'trigger.sh', 'check.sh'],
} as const satisfies Record<ScenarioKind, readonly string[]>;

export const SCENARIO_FILES = {
  code: [...SCENARIO_SCRIPTS.code, 'reference_fix.patch', 'meta.json'],
  ops: [...SCENARIO_SCRIPTS.ops, 'meta.json'],
} as const satisfies Record<ScenarioKind, readonly string[]>;

// Three digits then a kebab-case slug: 001-cart-total-off-by-one.
export const SCENARIO_ID = /^\d{3}(-[a-z0-9]+)+$/;

export interface Scenario {
  id: string;
  dir: string;
  kind: ScenarioKind;
  meta: ScenarioMeta;
}

/** Every problem with one scenario directory, reported together. */
export class ScenarioError extends Error {
  readonly id: string;
  readonly problems: string[];

  constructor(id: string, problems: string[]) {
    super(`scenario ${id}: ${problems.join('; ')}`);
    this.name = 'ScenarioError';
    this.id = id;
    this.problems = problems;
  }
}

/** What to print for a failed scenario: a ScenarioError's problems, or the error itself. */
export function problemsOf(err: unknown): string[] {
  return err instanceof ScenarioError ? err.problems : [String(err)];
}

/** Scenario directory names under `root`, sorted. Plain files (the README) are skipped. */
export async function listScenarioIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Checks a scenario directory's layout and parses its `meta.json`. The tier in meta.json
 * picks the kind, and the kind picks the files it needs.
 */
export async function loadScenario(dir: string): Promise<Scenario> {
  const id = basename(dir);
  const problems: string[] = [];
  if (!SCENARIO_ID.test(id)) problems.push(`id must match ${SCENARIO_ID}`);

  let meta: ScenarioMeta | undefined;
  let metaMissing = false;
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    const parsed = scenarioMetaSchema.safeParse(raw);
    if (parsed.success) meta = parsed.data;
    else
      problems.push(
        ...parsed.error.issues.map((i) => `meta.json ${i.path.join('.')}: ${i.message}`),
      );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      problems.push(`meta.json: ${(err as Error).message}`);
    } else metaMissing = true;
  }

  // Without a readable tier, check the code layout, which every scenario before Tier 3 has.
  const kind = meta ? scenarioKind(meta) : 'code';
  for (const file of SCENARIO_FILES[kind]) {
    if (file === 'meta.json' ? metaMissing : !(await exists(join(dir, file)))) {
      problems.push(`missing ${file}`);
    }
  }
  for (const script of SCENARIO_SCRIPTS[kind]) {
    const path = join(dir, script);
    if ((await exists(path)) && !(await exists(path, constants.X_OK))) {
      problems.push(`${script} is not executable`);
    }
  }
  // A file from the other kind means the tier or the layout is wrong, and one of them
  // would be silently ignored.
  const other = kind === 'ops' ? 'code' : 'ops';
  for (const file of SCENARIO_FILES[other]) {
    if ((SCENARIO_FILES[kind] as readonly string[]).includes(file)) continue;
    if (await exists(join(dir, file)))
      problems.push(`${file} is for ${other} scenarios (${tierText(other)})`);
  }

  if (problems.length > 0 || !meta) throw new ScenarioError(id, problems);
  return { id, dir, kind, meta };
}

function tierText(kind: ScenarioKind): string {
  return kind === 'ops' ? 'expectedTier 3' : 'expectedTier 1 or 2';
}

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}
