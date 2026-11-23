import type { OrchestratorLink } from '../link/link.ts';

type LiveKind = 'thinking' | 'reasoning' | 'output';

// How often pieces go out: often enough to read as streaming, few enough to stay cheap.
const FLUSH_MS = 150;
// The most one event carries; a longer burst goes out in several.
const MAX_EVENT_CHARS = 8_000;

/**
 * A run's live view: what the model is writing and what a command is printing, batched
 * and sent as `node.live` for the step it leads up to. flush() runs before each finished
 * step is sent, so the step replaces exactly the text that led to it.
 */
export class LiveStream {
  private pending: { kind: LiveKind; text: string }[] = [];
  private readonly timer: NodeJS.Timeout;

  private readonly link: OrchestratorLink;
  private readonly runId: string;
  /** The seq of the step the text leads up to: the steps recorded so far. */
  private readonly seq: () => number;

  constructor(link: OrchestratorLink, runId: string, seq: () => number) {
    this.link = link;
    this.runId = runId;
    this.seq = seq;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  push(kind: LiveKind, text: string): void {
    if (text === '') return;
    const last = this.pending.at(-1);
    if (last?.kind === kind) last.text += text;
    else this.pending.push({ kind, text });
  }

  flush(): void {
    const seq = this.seq();
    for (const { kind, text } of this.pending) {
      for (let i = 0; i < text.length; i += MAX_EVENT_CHARS) {
        this.link.send('node.live', {
          v: 1,
          runId: this.runId,
          seq,
          kind,
          text: text.slice(i, i + MAX_EVENT_CHARS),
        });
      }
    }
    this.pending = [];
  }

  stop(): void {
    clearInterval(this.timer);
    this.flush();
  }
}
