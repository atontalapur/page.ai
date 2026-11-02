// Usage: OPENROUTER_API_KEY=... node eval/scripts/record-transcript.ts <image> <scenario-id> --model <id>
// Breaks a fresh sandbox with the scenario's break.sh, lets the agent try to fix it with a
// real model, runs check.sh, and saves the run as a replay fixture for @page/agent. Run
// from the repo root. Prints the run's outcome and the agent's diff.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_AGENT_CONFIG,
  recordingDeps,
  runAgent,
  TRANSCRIPT_VERSION,
  type Transcript,
} from '@page/agent';
import { OpenRouterClient, withRetries } from '@page/model-client';
import { DEFAULT_TIMEOUT_MS, DockerExecRunner, execute } from '@page/toolkit';
import { loadScenario } from '../src/scenario.ts';
import { shellIn, startSandbox, stopSandbox } from './sandbox.ts';

const USAGE =
  'usage: OPENROUTER_API_KEY=... node eval/scripts/record-transcript.ts <image> <scenario-id> --model <id> [--out <dir>]';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: 'string' },
    out: { type: 'string', default: 'packages/agent/src/__fixtures__/transcripts' },
  },
});
const [image, id] = positionals;
const apiKey = process.env.OPENROUTER_API_KEY;
if (!image || !id || !values.model || !apiKey) {
  console.error(USAGE);
  process.exit(2);
}

const scenario = await loadScenario(join('scenarios', id));
const [breakScript, checkScript] = await Promise.all(
  ['break.sh', 'check.sh'].map((f) => readFile(join(scenario.dir, f), 'utf8')),
);

// The sandbox's own wall clock starts with the container, so the agent's budget does too.
const containerStartedAt = Date.now();
const name = startSandbox(image);
try {
  const sh = shellIn(name);
  const broke = await sh(breakScript!);
  if (broke.code !== 0) throw new Error(`break.sh exited ${broke.code}:\n${broke.output}`);

  const runner = new DockerExecRunner({ container: name });
  const tier = scenario.meta.expectedTier;
  const recording = recordingDeps({
    model: withRetries(new OpenRouterClient({ apiKey, model: values.model })),
    execute: (call, { timeoutMs = Infinity }) =>
      execute(call, { tier, runner, timeoutMs: Math.min(DEFAULT_TIMEOUT_MS, timeoutMs) }),
  });
  // The scenario's description stands in for the triaged error report until ingest (#30)
  // can produce one.
  const task = { task: scenario.meta.description };
  // Setup (container start, break.sh) comes out of the budget. Saving the shortened limit
  // in the config keeps the replay exact.
  const config = {
    ...DEFAULT_AGENT_CONFIG,
    wallTimeLimitMs: DEFAULT_AGENT_CONFIG.wallTimeLimitMs - (Date.now() - containerStartedAt),
  };
  const run = await runAgent(task, recording.deps, config);

  // check.sh goes over stdin after the run, so the agent never sees it.
  const check = await sh(checkScript!);
  const diff = await sh('git diff');

  const transcript: Transcript = {
    version: TRANSCRIPT_VERSION,
    scenario: id,
    model: values.model,
    recordedAt: new Date().toISOString(),
    task,
    config,
    exitStatus: run.exitStatus,
    modelCalls: run.modelCalls,
    costUsd: run.costUsd,
    checkPassed: check.code === 0,
    turns: recording.turns,
    clock: recording.clock,
  };
  await mkdir(values.out, { recursive: true });
  const path = join(values.out, `${id}.json`);
  await writeFile(path, `${JSON.stringify(transcript, null, 2)}\n`);

  console.log(`exit:       ${run.exitStatus}${run.error ? ` (${run.error.message})` : ''}`);
  console.log(`model:      ${values.model}, ${run.modelCalls} calls, $${run.costUsd.toFixed(4)}`);
  console.log(`check.sh:   ${check.code === 0 ? 'passed' : `failed (exit ${check.code})`}`);
  console.log(`transcript: ${path}`);
  console.log(`\n${diff.output || '(no diff)'}`);
} finally {
  stopSandbox(name);
}
