import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgent } from './agent.ts';
import { replayDeps, TRANSCRIPT_VERSION, type Transcript } from './transcript.ts';

// Real runs, recorded with eval/scripts/record-transcript.ts against a sandbox and a model.
const DIR = join(import.meta.dirname, '__fixtures__', 'transcripts');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const load = (file: string) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Transcript;

describe('recorded transcripts', () => {
  it('has at least one transcript to replay', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s replays to the recorded end', async (file) => {
    const transcript = load(file);
    expect(transcript.version).toBe(TRANSCRIPT_VERSION);

    const replay = replayDeps(transcript);
    const run = await runAgent(transcript.task, replay.deps, transcript.config);

    expect({
      exitStatus: run.exitStatus,
      modelCalls: run.modelCalls,
      costUsd: run.costUsd,
    }).toEqual({
      exitStatus: transcript.exitStatus,
      modelCalls: transcript.modelCalls,
      costUsd: transcript.costUsd,
    });
    expect(replay.remaining()).toBe(0);
  });
});
