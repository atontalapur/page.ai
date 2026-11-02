// The port execute() runs commands through. DockerExecRunner runs them in the run's
// sandbox container; FakeRunner stands in for it in tests.

export interface RunRequest {
  /** A command line already approved by the policy. Runs under `sh -c` in the workspace. */
  command: string;
  timeoutMs: number;
  /** Written to the command's stdin, then stdin is closed. */
  stdin?: string;
}

export type RunResult =
  | { status: 'exited'; exitCode: number; stdout: string; stderr: string }
  | { status: 'timed_out'; stdout: string; stderr: string };

export interface ExecRunner {
  /** Resolves for anything the command does; rejects only when the runner itself breaks. */
  run(request: RunRequest): Promise<RunResult>;
}
