import { CpuIcon } from '@solar-icons/react/bold-duotone';

import { useRunLive } from '../../live/useRunLive';
import { Enter } from './threadMotion';
import { Terminal } from './ToolCall';

/**
 * The step a running agent is on, as it happens: its reply typing out, then the command's
 * output growing in place. The thread scroller follows that growth. The finished step
 * replaces this.
 */
export default function LiveTail({ runId }: { runId: string }) {
  const live = useRunLive(runId);

  return (
    <Enter>
      <div aria-label="Live" aria-live="polite" className="space-y-2">
        {!live || (live.thinking === '' && live.output === '' && live.reasoning === '') ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-violet-9" aria-hidden />
            The agent is working…
          </p>
        ) : (
          <>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-violet-9" aria-hidden />
              <span className="tabular-nums">Step {live.seq}</span>
            </p>
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
          </>
        )}
      </div>
    </Enter>
  );
}
