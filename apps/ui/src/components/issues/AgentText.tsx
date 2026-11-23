import { Fragment, type ReactNode } from 'react';

/**
 * The agent's reasoning, which it writes as light markdown: paragraphs, `code`, **bold**,
 * fenced blocks and `-` lists. Built as React elements, never as HTML, so model output
 * can't inject markup. Anything else stays plain text.
 */
export default function AgentText({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{blocks(text)}</div>;
}

const LIST_ITEM = /^\s*[-*]\s+/;

function blocks(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Even parts are prose, odd parts are the insides of ``` fences.
  text.split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(
        <pre
          key={`code-${i}`}
          className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs"
        >
          <code>{part.replace(/\n$/, '')}</code>
        </pre>,
      );
      return;
    }
    part.split(/\n{2,}/).forEach((block, j) => {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      let paragraph: string[] = [];
      let list: string[] = [];
      const flush = (k: string) => {
        if (paragraph.length) {
          out.push(<p key={`p-${k}`}>{inline(paragraph.join(' '))}</p>);
          paragraph = [];
        }
        if (list.length) {
          out.push(
            <ul key={`ul-${k}`} className="list-disc space-y-0.5 pl-5">
              {list.map((item, n) => (
                <li key={n}>{inline(item)}</li>
              ))}
            </ul>,
          );
          list = [];
        }
      };
      lines.forEach((line, k) => {
        if (LIST_ITEM.test(line)) {
          if (paragraph.length) flush(`${i}-${j}-${k}`);
          list.push(line.replace(LIST_ITEM, ''));
        } else {
          if (list.length) flush(`${i}-${j}-${k}`);
          paragraph.push(line.trim());
        }
      });
      flush(`${i}-${j}-end`);
    });
  });
  return out;
}

/** `code` and **bold** within a line. */
function inline(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((piece, i) => {
    if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">
          {piece.slice(1, -1)}
        </code>
      );
    }
    if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) {
      return <strong key={i}>{piece.slice(2, -2)}</strong>;
    }
    return <Fragment key={i}>{piece}</Fragment>;
  });
}
