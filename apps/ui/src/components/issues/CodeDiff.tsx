import { Component, lazy, Suspense, type ReactNode } from 'react';

// @pierre/diffs carries Shiki, so it loads in its own chunk when a diff is first shown.
const PatchDiff = lazy(() => import('@pierre/diffs/react').then((m) => ({ default: m.PatchDiff })));
const MultiFileDiff = lazy(() =>
  import('@pierre/diffs/react').then((m) => ({ default: m.MultiFileDiff })),
);

export type DiffStyle = 'unified' | 'split';

// themeType 'system' colours with light-dark(), which follows the host's color-scheme, and
// index.css sets that from the theme toggle's `.dark` class.
const options = (diffStyle: DiffStyle) =>
  ({ diffStyle, themeType: 'system', overflow: 'wrap', disableFileHeader: true }) as const;

/** A unified git patch, highlighted. */
export function PatchView({
  patch,
  diffStyle = 'unified',
}: {
  patch: string;
  diffStyle?: DiffStyle;
}) {
  const plain = (
    <PlainDiff
      lines={patch.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))}
    />
  );
  return (
    <Fallback plain={plain}>
      <Suspense fallback={plain}>
        <PatchDiff patch={patch} options={options(diffStyle)} className="diff-view" />
      </Suspense>
    </Fallback>
  );
}

/** One edit the agent made: the text it replaced and what it put there. */
export function EditView({
  path,
  oldText,
  newText,
}: {
  path: string;
  oldText: string;
  newText: string;
}) {
  const plain = <PlainDiff lines={changedLines(oldText, newText)} />;
  return (
    <Fallback plain={plain}>
      <Suspense fallback={plain}>
        <MultiFileDiff
          oldFile={{ name: path, contents: oldText }}
          newFile={{ name: path, contents: newText }}
          options={options('unified')}
          className="diff-view"
        />
      </Suspense>
    </Fallback>
  );
}

/** What shows while the highlighter loads, and if it can't. */
function PlainDiff({ lines }: { lines: string[] }) {
  return (
    <pre className="overflow-x-auto py-2 font-mono text-xs leading-5" data-testid="plain-diff">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`whitespace-pre-wrap break-words px-3 ${
            line.startsWith('@@')
              ? 'text-muted-foreground'
              : line.startsWith('+')
                ? 'bg-green-a3'
                : line.startsWith('-')
                  ? 'bg-red-a3'
                  : ''
          }`}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

/** Unchanged head and tail as context, the middle as removed then added lines. */
function changedLines(oldText: string, newText: string): string[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  return [
    ...a.slice(0, head).map((l) => ` ${l}`),
    ...a.slice(head, a.length - tail).map((l) => `-${l}`),
    ...b.slice(head, b.length - tail).map((l) => `+${l}`),
    ...a.slice(a.length - tail).map((l) => ` ${l}`),
  ];
}

/** Keeps the plain diff if the highlighter's chunk fails to load or throws. */
class Fallback extends Component<{ plain: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.plain : this.props.children;
  }
}
