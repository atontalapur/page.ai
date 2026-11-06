// Railway's ALWAYS restart policy (railway.json) and compose's `restart: unless-stopped`
// start the app again after it exits, so exiting is the whole restart. ALWAYS rather than
// ON_FAILURE because ON_FAILURE gives up after a set number of restarts per deployment,
// which repeated ops restarts would use up. The exit is non-zero all the same, so the
// platform logs it as a stop the app didn't choose for itself.
export const RESTART_EXIT_CODE = 1;
// Long enough for the 202 to reach the caller before the process goes.
export const RESTART_DELAY_MS = 500;

export interface Restarter {
  /** Exits the process shortly. Calling it again before then does nothing more. */
  schedule(): void;
}

export function processRestarter(
  exit: (code: number) => void = (code) => process.exit(code),
  delayMs = RESTART_DELAY_MS,
): Restarter {
  let scheduled = false;
  return {
    schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => exit(RESTART_EXIT_CODE), delayMs);
    },
  };
}
