import type { ExecRunner, RunRequest, RunResult } from './runner.ts';

type Responder = (request: RunRequest) => RunResult | Promise<RunResult>;

/**
 * An ExecRunner for tests. Records every request and answers with `respond`, which by
 * default exits 0 with no output.
 */
export class FakeRunner implements ExecRunner {
  readonly requests: RunRequest[] = [];
  private readonly respond: Responder;

  constructor(respond: Responder = () => FakeRunner.exited(0)) {
    this.respond = respond;
  }

  static exited(exitCode: number, stdout = '', stderr = ''): RunResult {
    return { status: 'exited', exitCode, stdout, stderr };
  }

  static timedOut(stdout = '', stderr = ''): RunResult {
    return { status: 'timed_out', stdout, stderr };
  }

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    return this.respond(request);
  }
}
