import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { MagnifierIcon, StructureIcon } from '@solar-icons/react/bold-duotone';
import type { KgBranch, KgGraph, KgNodeDetail, KgSearchResult } from '@page/contracts';
import { Button } from '@page/design-system/components/ui/button';
import { Card } from '@page/design-system/components/ui/card';
import { Input } from '@page/design-system/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@page/design-system/components/ui/native-select';

import TokenPrompt from '../components/issues/TokenPrompt';
import GraphCanvas from '../components/knowledge/GraphCanvas';
import NodePage from '../components/knowledge/NodePage';
import { useIssues } from '../context/IssuesContext';
import { loadBranches, loadGraph, loadNode, searchGraph } from '../live/knowledge';

// New writes from runs in progress show up without a reload.
const REFRESH_MS = 10_000;

/**
 * The knowledge graph the agents keep: an Obsidian-style graph of every node a branch sees,
 * a search by meaning, and the node you pick, laid out as a page with its history.
 */
export default function KnowledgePage() {
  const { status } = useIssues();
  const [branches, setBranches] = useState<KgBranch[]>([]);
  const [branch, setBranch] = useState('main');
  const [graph, setGraph] = useState<KgGraph | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<KgNodeDetail | undefined>();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KgSearchResult | undefined>();
  const [searching, setSearching] = useState(false);
  // Test files are half the graph; they stay out of the view until asked for.
  const [showTests, setShowTests] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [b, g] = await Promise.all([loadBranches(), loadGraph(branch)]);
      setBranches(b);
      setGraph(g);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [branch]);

  useEffect(() => {
    if (status === 'needs_token') return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, status]);

  useEffect(() => {
    if (selected === undefined) {
      setDetail(undefined);
      return;
    }
    let live = true;
    loadNode(branch, selected).then(
      (d) => live && setDetail(d),
      () => live && setDetail(undefined),
    );
    return () => {
      live = false;
    };
    // The graph's refresh reloads the open page too, so its history stays current.
  }, [branch, selected, graph]);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (query.trim() === '') return;
    setSearching(true);
    try {
      const found = await searchGraph(branch, query.trim());
      setResult(found);
      if (found.matches[0]) setSelected(found.matches[0].node.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  const highlighted = useMemo(
    () => new Set(result?.matches.map((m) => m.node.key) ?? []),
    [result],
  );
  const onSelect = useCallback((key: string) => setSelected(key), []);
  const shown = useMemo(() => {
    if (!graph || showTests) return graph;
    const nodes = graph.nodes.filter((n) => n.kind !== 'test');
    const keys = new Set(nodes.map((n) => n.key));
    return {
      ...graph,
      nodes,
      edges: graph.edges.filter((e) => keys.has(e.from) && keys.has(e.to)),
    };
  }, [graph, showTests]);
  const current = branches.find((b) => b.name === branch);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <StructureIcon className="size-6 text-muted-foreground" aria-hidden />
            Knowledge
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            What the agents have learned about the demo repo. Each run writes to its own branch; a
            merged fix brings its branch onto main.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showTests}
              onChange={(e) => setShowTests(e.target.checked)}
              className="size-4 accent-[var(--violet-9)]"
            />
            Show tests
          </label>
          <label htmlFor="kg-branch" className="text-sm text-muted-foreground">
            Branch
          </label>
          <NativeSelect
            id="kg-branch"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setResult(undefined);
            }}
          >
            {(branches.length > 0 ? branches : [{ name: 'main' } as KgBranch]).map((b) => (
              <NativeSelectOption key={b.name} value={b.name}>
                {b.name === 'main'
                  ? 'main'
                  : `run ${b.name.slice('pageagents/'.length, 'pageagents/'.length + 8)}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>

      <TokenPrompt />

      {status === 'needs_token' ? null : (
        <>
          <form onSubmit={(e) => void search(e)} className="flex max-w-xl gap-2" role="search">
            <label htmlFor="kg-search" className="sr-only">
              Search the knowledge graph
            </label>
            <Input
              id="kg-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by meaning, such as how shipping is priced"
            />
            <Button type="submit" variant="outline" disabled={searching || query.trim() === ''}>
              <MagnifierIcon className="size-4" aria-hidden />
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </form>

          {error && (
            <p role="alert" className="text-sm text-red-11">
              {error}
            </p>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
            <Card className="relative h-[70vh] min-h-96 overflow-hidden p-0">
              {shown && shown.nodes.length > 0 ? (
                <GraphCanvas
                  nodes={shown.nodes}
                  edges={shown.edges}
                  selected={selected}
                  highlighted={highlighted}
                  onSelect={onSelect}
                />
              ) : (
                <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                  {graph
                    ? 'Nothing here yet. Agents write what they learn as they fix bugs, and seeding reads main from the demo repo.'
                    : 'Loading the graph…'}
                </div>
              )}
              {shown && (
                <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-muted-foreground tabular-nums">
                  {shown.nodes.length} pages · {shown.edges.length} links
                  {current && current.unpushed > 0 ? ` · ${current.unpushed} not pushed` : ''}
                </p>
              )}
            </Card>

            <Card className="h-[70vh] min-h-96 overflow-y-auto">
              {detail ? (
                <NodePage detail={detail} repo={graph?.repo ?? null} onOpen={onSelect} />
              ) : (
                <nav aria-label="Pages" className="space-y-1 p-3">
                  <h3 className="px-2 text-sm font-semibold text-muted-foreground">Pages</h3>
                  {result && (
                    <p className="px-2 text-xs text-muted-foreground">
                      {result.matches.length} match(es) for &ldquo;{result.query}&rdquo;
                    </p>
                  )}
                  <ul>
                    {(shown?.nodes ?? []).map((n) => (
                      <li key={n.key}>
                        <button
                          type="button"
                          onClick={() => setSelected(n.key)}
                          className="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-slate-a3"
                        >
                          {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
              )}
              {detail && (
                <div className="border-t border-border p-2">
                  <Button variant="ghost" size="sm" onClick={() => setSelected(undefined)}>
                    All pages
                  </Button>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
