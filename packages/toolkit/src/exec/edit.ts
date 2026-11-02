import { posix } from 'node:path';
import { WORKSPACE, writePathRefusal } from '../policy/paths.ts';
import { err, ok, type Result } from '../result.ts';
import type { RunResult } from './runner.ts';
import { combineOutput, DEFAULT_OUTPUT_BUDGET, trimOutput } from './trim.ts';
import type { EditCall, ExecContext, ExecErr, ExecOk, StepBase } from './types.ts';

/** Reading or writing one file should take well under this. */
export const EDIT_TIMEOUT_MS = 30_000;
// The runner keeps only the head and tail of very long output, so a bigger file would come
// back cut and be written back corrupted. Source files are far smaller.
export const MAX_EDIT_BYTES = 500_000;

/** Quotes a string as one sh word. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const failed = (base: StepBase, output: string, exitCode = 1) =>
  err<ExecErr>({ ...base, type: 'failed', exitCode, output });

// Overlapping matches count: `aa` in `aaa` matches twice, so the edit is ambiguous.
function countOccurrences(text: string, part: string): number {
  let count = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + 1)) {
    count += 1;
  }
  return count;
}

/**
 * The file-edit tool. The path gets the same check as a redirect; the content goes over
 * stdin, so it never passes through a shell command line.
 */
export async function runEdit(
  call: EditCall,
  ctx: ExecContext,
  base: StepBase,
): Promise<Result<ExecOk, ExecErr>> {
  const refusal = writePathRefusal(call.path);
  if (refusal !== null) return err({ ...base, type: 'refused', message: `refused: ${refusal}` });

  // Absolute, so a path such as `-x` can't be read as an option.
  const absolute = posix.resolve(WORKSPACE, call.path);
  const path = shellQuote(absolute);
  const run = (command: string, stdin?: string): Promise<RunResult> =>
    ctx.runner.run({ command, timeoutMs: EDIT_TIMEOUT_MS, stdin });
  const problem = (result: RunResult): Result<ExecOk, ExecErr> | null => {
    if (result.status === 'timed_out') {
      return err({ ...base, type: 'timed_out', output: `${call.path}: timed out` });
    }
    if (result.exitCode !== 0) {
      const output = combineOutput(result.stdout, result.stderr);
      return failed(
        base,
        trimOutput(output, ctx.outputBudget ?? DEFAULT_OUTPUT_BUDGET),
        result.exitCode,
      );
    }
    return null;
  };

  if (call.oldText === '') {
    const dir = shellQuote(posix.dirname(absolute));
    const exists = shellQuote(`${call.path} already exists; give oldText to change it`);
    const created = await run(
      `if [ -e ${path} ]; then echo ${exists} >&2; exit 1; fi; mkdir -p ${dir} && cat > ${path}`,
      call.newText,
    );
    return problem(created) ?? ok({ ...base, exitCode: 0, output: `created ${call.path}` });
  }

  const tooBig = shellQuote(`${call.path} is over ${MAX_EDIT_BYTES} bytes; edit it another way`);
  const missing = shellQuote(`${call.path} does not exist; give an empty oldText to create it`);
  const read = await run(
    `[ -f ${path} ] || { echo ${missing} >&2; exit 1; }; ` +
      `[ "$(wc -c < ${path})" -le ${MAX_EDIT_BYTES} ] || { echo ${tooBig} >&2; exit 1; }; ` +
      `cat ${path}`,
  );
  const readProblem = problem(read);
  if (readProblem !== null) return readProblem;
  // The runner decodes output as UTF-8; anything else would be written back mangled.
  if (read.stdout.includes('\uFFFD')) return failed(base, `${call.path} is not a UTF-8 text file`);

  const matches = countOccurrences(read.stdout, call.oldText);
  if (matches === 0) return failed(base, `oldText was not found in ${call.path}`);
  if (matches > 1) {
    return failed(
      base,
      `oldText appears ${matches} times in ${call.path}; include more context so it matches once`,
    );
  }

  const written = await run(
    `cat > ${path}`,
    read.stdout.replace(call.oldText, () => call.newText),
  );
  return problem(written) ?? ok({ ...base, exitCode: 0, output: `edited ${call.path}` });
}
