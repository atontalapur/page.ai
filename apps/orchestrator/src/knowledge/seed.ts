import { posix } from 'node:path';
import { MAIN_BRANCH } from '@page/contracts';
import type { GitHubApi } from '../github/github-api.ts';
import type { KnowledgeService } from './knowledge.service.ts';

// The demo app's source, as the sandbox workspace lays it out.
const ROOT = 'apps/demo-app/src/';
const SOURCE = /\.(ts|tsx)$/;
// Skip a file this big: it's generated or data, not code worth a node.
const MAX_FILE_BYTES = 60_000;
const DOC = /\/\*\*([\s\S]*?)\*\//;
const EXPORT =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const IMPORT = /^import[\s\S]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm;

export interface SeededFile {
  path: string;
  kind: 'file' | 'test';
  title: string;
  body: string;
  imports: string[];
}

/** What one source file says about itself: its doc comment, its exports, what it imports. */
export function describeFile(path: string, text: string): SeededFile {
  const kind = /\.test\.tsx?$/.test(path) ? 'test' : 'file';
  const doc = DOC.exec(text)?.[1]
    ?.split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
  const exports = [...text.matchAll(EXPORT)].map((m) => m[1]!);
  const imports = [...text.matchAll(IMPORT)].map((m) => m[1]!);
  const name = path.slice(ROOT.length);
  const lines = [
    doc ?? '',
    exports.length > 0 ? `Exports: ${exports.join(', ')}.` : '',
    `${text.split('\n').length} lines.`,
  ].filter(Boolean);
  return {
    path,
    kind,
    title: kind === 'test' ? `Tests: ${name}` : name,
    body: lines.join('\n\n'),
    imports,
  };
}

/** The repo path an import names, if it is one of `known`. */
function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.(js|ts|tsx)$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`].find((p) =>
    known.has(p),
  );
}

/**
 * Seeds main from the demo repo's main branch: a node per source file, linked by its
 * imports, and every version stamped with main's head commit, which is on the remote.
 * Running it again writes only what changed.
 */
export async function seedMain(
  github: GitHubApi,
  knowledge: KnowledgeService,
  author: string,
): Promise<{ commit: string; nodes: number; edges: number; stamped: number }> {
  const commit = await github.head('main');
  const files = (await github.files(commit)).filter(
    (f) => f.path.startsWith(ROOT) && SOURCE.test(f.path) && f.size <= MAX_FILE_BYTES,
  );
  const known = new Set(files.map((f) => f.path));
  const described: SeededFile[] = [];
  for (const file of files) described.push(describeFile(file.path, await github.text(file.sha)));

  const by = { runId: null, author };
  for (const file of described) {
    await knowledge.writeNode(
      MAIN_BRANCH,
      { key: `file:${file.path}`, kind: file.kind, title: file.title, body: file.body },
      by,
    );
  }
  let edges = 0;
  for (const file of described) {
    for (const spec of file.imports) {
      const target = resolveImport(file.path, spec, known);
      if (!target || target === file.path) continue;
      const relation = file.kind === 'test' ? 'tests' : 'imports';
      await knowledge.writeEdge(
        MAIN_BRANCH,
        { from: `file:${file.path}`, to: `file:${target}`, relation },
        by,
      );
      edges += 1;
    }
  }
  const stamped = await knowledge.stampCommit(MAIN_BRANCH, commit);
  return { commit, nodes: described.length, edges, stamped };
}
