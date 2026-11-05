// Railway's ON_FAILURE restart policy (railway.json) and compose's `restart: on-failure`
// start the app again after a non-zero exit, so exiting is the whole restart.
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
