export const dbSteps = ['migrate', 'seed'] as const;
export type DbStep = (typeof dbSteps)[number];

const isStep = (arg: string): arg is DbStep => (dbSteps as readonly string[]).includes(arg);

/**
 * Reads the steps for `scripts/db.ts` from its args, run in the order given. Any other arg
 * fails the whole command, so a shell command passed without a shell
 * (`migrate && node scripts/db.ts seed`) errors instead of quietly running only `migrate`.
 */
export function parseSteps(args: readonly string[]): DbStep[] | undefined {
  if (args.length === 0 || !args.every(isStep)) return undefined;
  return [...args];
}
