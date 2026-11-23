import { useEffect, useRef } from 'react';
import { CpuIcon } from '@solar-icons/react/bold-duotone';

import { useRunLive } from '../../live/useRunLive';
import { Terminal } from './ToolCall';

/**
 * The step a running agent is on, as it happens: its reply typing out, then the command's
 * output scrolling in. The finished step replaces it.
 */
export default function LiveTail({ runId }: { runId: string }) {
  const live = useRunLive(runId);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [live?.output]);

  if (!live || (live.thinking === '' && live.output === '' && live.reasoning === '')) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
        <span className="size-2 animate-pulse rounded-full bg-violet-9" aria-hidden />
        The agent is working…
      </div>
    );
  }
  return (
    <section
      aria-label="Live"
      aria-live="polite"
      className="grid gap-3 px-4 py-4 md:grid-cols-[8rem_minmax(0,1fr)] md:gap-4"
    >
      <div className="space-y-0.5">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <span className="size-2 animate-pulse rounded-full bg-violet-9" aria-hidden />
          Live
        </h4>
        <p className="text-xs text-muted-foreground tabular-nums">Step {live.seq}</p>
      </div>
      <div className="min-w-0 space-y-3">
        {live.reasoning && (
          <details>
            <summary className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
              <CpuIcon className="size-3.5" aria-hidden />
              Reasoning
            </summary>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
              {live.reasoning}
            </p>
          </details>
        )}
        {live.thinking && (
          <p className="whitespace-pre-wrap text-sm leading-6">
            {live.thinking}
            {live.output === '' && (
              <span
                className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground align-text-bottom"
                aria-hidden
              />
            )}
          </p>
        )}
        {live.output && <Terminal output={live.output} running />}
        <div ref={end} />
      </div>
    </section>
  );
}
