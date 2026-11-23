import { useEffect, useState } from 'react';

import { useRunFeed } from '../context/IssuesContext';
import { runIdOf } from './source';

/** What a run is doing right now, before the step that will hold it arrives. */
export interface RunLive {
  /** The step it leads up to. */
  seq: number;
  /** The model's reply so far. */
  thinking: string;
  /** The model's own reasoning so far, for models that send it apart. */
  reasoning: string;
  /** The running command's output so far. */
  output: string;
}

// The most of a command's output kept for the live view; the finished step has it all.
const MAX_OUTPUT_CHARS = 40_000;

/**
 * The live view of `runId`: `run.live` pieces for the step in progress, cleared once that
 * step, or the end of the run, arrives.
 */
export function useRunLive(runId: string): RunLive | undefined {
  const { subscribeRuns } = useRunFeed();
  const [live, setLive] = useState<RunLive | undefined>();

  useEffect(() => {
    setLive(undefined);
    return subscribeRuns((event) => {
      if (runIdOf(event) !== runId) return;
      if (event.event === 'run.live') {
        const { seq, kind, text } = event.payload;
        setLive((current) => {
          const base =
            current && current.seq === seq
              ? current
              : { seq, thinking: '', reasoning: '', output: '' };
          if (kind === 'output') {
            return { ...base, output: (base.output + text).slice(-MAX_OUTPUT_CHARS) };
          }
          return kind === 'thinking'
            ? { ...base, thinking: base.thinking + text }
            : { ...base, reasoning: base.reasoning + text };
        });
      } else if (event.event === 'run.step') {
        const { seq } = event.payload.step;
        setLive((current) => (current && seq >= current.seq ? undefined : current));
      } else if (event.event === 'run.finished') {
        setLive(undefined);
      }
    });
  }, [runId, subscribeRuns]);

  return live;
}
