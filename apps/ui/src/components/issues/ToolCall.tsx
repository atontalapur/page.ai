import { useState, type ComponentType } from 'react';
import {
  BranchingPathsUpIcon,
  DatabaseIcon,
  DocumentTextIcon,
  MagnifierIcon,
  RestartIcon,
  SettingsMinimalisticIcon,
  SquareShareLineIcon,
  StructureIcon,
} from '@solar-icons/react/bold-duotone';
import type { Step } from '@page/contracts';

type Icon = ComponentType<{ className?: string }>;

interface Described {
  icon: Icon;
  /** What the agent did, in words. */
  title: string;
  /** The detail that matters, such as the query or the setting. */
  detail?: string;
  /** Longer text the card can open, such as a PR's description or a page's body. */
  more?: string;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/** A host tool call as a person reads it, from the step's input (hostToolArgs). */
export function describeToolCall(input: string): Described {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return { icon: SettingsMinimalisticIcon, title: input };
  }
  switch (args.tool) {
    case 'kg.search':
      return {
        icon: MagnifierIcon,
        title: 'Searched the knowledge graph',
        detail: str(args.query),
      };
    case 'kg.read':
      return { icon: StructureIcon, title: 'Read a knowledge page', detail: str(args.key) };
    case 'kg.write':
      return {
        icon: StructureIcon,
        title: `Wrote “${str(args.title)}” to the knowledge graph`,
        detail: [str(args.key), str(args.links) && `links ${str(args.links)}`]
          .filter(Boolean)
          .join(' · '),
        more: str(args.body),
      };
    case 'ops.getConfig':
      return { icon: SettingsMinimalisticIcon, title: 'Read the live app’s settings' };
    case 'ops.setConfig':
      return {
        icon: SettingsMinimalisticIcon,
        title: `Set ${str(args.key)} on the live app`,
        detail: `${str(args.key)} = ${str(args.value)}`,
      };
    case 'ops.deleteConfig':
      return {
        icon: SettingsMinimalisticIcon,
        title: `Dropped the ${str(args.key)} override`,
        detail: 'The env value applies again after a restart.',
      };
    case 'ops.restart':
      return { icon: RestartIcon, title: 'Restarted the live app' };
    case 'ops.planRollback':
      return { icon: DatabaseIcon, title: 'Planned a rollback of the live deploy' };
    case 'ops.rollback':
      return { icon: DatabaseIcon, title: 'Rolled the live app back', detail: str(args.to) };
    case 'git.pushBranch':
      return {
        icon: BranchingPathsUpIcon,
        title: 'Pushed the fix to its branch',
        detail: str(args.message),
      };
    case 'github.openPr':
      return {
        icon: SquareShareLineIcon,
        title: 'Opened a pull request',
        detail: str(args.title),
        more: str(args.body),
      };
    default:
      return { icon: DocumentTextIcon, title: str(args.tool) || 'Used a tool' };
  }
}

/** A host tool call as a card: what it did, its detail, and what came back. */
export function ToolCallCard({
  step,
  label,
  toneClass,
}: {
  step: Step;
  label: string;
  toneClass: string;
}) {
  const { icon: Icon, title, detail, more } = describeToolCall(step.input);
  const [open, setOpen] = useState(false);
  const result = step.allowed ? step.outputTrimmed : '';
  return (
    <div className="overflow-hidden rounded-md border bg-card">
      <div className="flex items-start gap-3 px-3 py-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-violet-a3 text-violet-11">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          {detail && (
            <p className="truncate text-xs text-muted-foreground" title={detail}>
              {detail}
            </p>
          )}
        </div>
        <span className={`shrink-0 pt-0.5 text-xs font-medium ${toneClass}`}>{label}</span>
      </div>
      {(more || result) && (
        <div className="border-t bg-muted/30 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? 'Hide details' : 'Show details'}
          </button>
          {open && (
            <div className="mt-1.5 space-y-2 pb-1">
              {more && <p className="whitespace-pre-wrap text-xs leading-5">{more}</p>}
              {result && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-xs">
                  {result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A command as a terminal: the prompt line, then its output, scrolling. A finished one
 * shows its exit code; a running one shows a cursor.
 */
export function Terminal({
  command,
  output,
  label,
  toneClass,
  running = false,
}: {
  command?: string;
  output: string;
  label?: string;
  toneClass?: string;
  running?: boolean;
}) {
  const [open, setOpen] = useState(running);
  const showOutput = running || open;
  return (
    <div className="overflow-hidden rounded-md border border-slate-a5 bg-slate-12 text-slate-1 dark:bg-slate-2 dark:text-slate-12">
      {command !== undefined && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={showOutput}
          disabled={output === ''}
          className="flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-xs"
        >
          <span className="text-green-9" aria-hidden>
            $
          </span>
          <span className="min-w-0 flex-1 truncate" title={command}>
            {command}
          </span>
          {label && (
            <span className={`shrink-0 font-sans font-medium ${toneClass ?? ''}`}>{label}</span>
          )}
        </button>
      )}
      {showOutput && output !== '' && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-slate-a6 px-3 py-2 font-mono text-[11px] leading-5 opacity-90">
          {output}
          {running && (
            <span
              className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle"
              aria-hidden
            />
          )}
        </pre>
      )}
    </div>
  );
}
