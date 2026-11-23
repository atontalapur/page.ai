import { DocumentTextIcon, HistoryIcon, LinkRoundIcon } from '@solar-icons/react/bold-duotone';
import type { KgNodeDetail, KgVersion } from '@page/contracts';

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function Property({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Commit({ version, repo }: { version: KgVersion; repo: string | null }) {
  if (version.commitSha === null) {
    return (
      <span className="rounded-md bg-amber-a3 px-1.5 py-0.5 text-xs text-amber-11">not pushed</span>
    );
  }
  const short = version.commitSha.slice(0, 7);
  return repo ? (
    <a
      href={`https://github.com/${repo}/commit/${version.commitSha}`}
      target="_blank"
      rel="noreferrer"
      className="rounded-md bg-slate-a3 px-1.5 py-0.5 font-mono text-xs underline-offset-2 hover:underline"
    >
      {short}
    </a>
  ) : (
    <span className="rounded-md bg-slate-a3 px-1.5 py-0.5 font-mono text-xs">{short}</span>
  );
}

/**
 * One node, laid out like a Notion page: a big title, a properties table, the body as
 * text, its linked pages, and its history with the commit that carried each version.
 */
export default function NodePage({
  detail,
  repo,
  onOpen,
}: {
  detail: KgNodeDetail;
  repo: string | null;
  onOpen: (key: string) => void;
}) {
  const { node, versions, edges, linked } = detail;
  const titleOf = new Map(linked.map((n) => [n.key, n.title]));
  return (
    <article className="mx-auto max-w-[65ch] space-y-6 px-2 py-4">
      <header className="space-y-3">
        <DocumentTextIcon className="size-9 text-muted-foreground" aria-hidden />
        <h2 className="text-3xl font-bold tracking-tight text-balance">{node.title}</h2>
        <dl className="divide-y divide-border">
          <Property label="Kind">
            <span className="rounded-md bg-violet-a3 px-1.5 py-0.5 text-xs text-violet-11">
              {node.kind}
            </span>
          </Property>
          <Property label="Key">
            <code className="font-mono text-xs">{node.key}</code>
          </Property>
          <Property label="Branch">{node.branch}</Property>
          <Property label="Version">
            <span className="tabular-nums">{node.version}</span>
          </Property>
          <Property label="Edited">{when(node.updatedAt)}</Property>
        </dl>
      </header>

      <section aria-label="Content" className="space-y-3 text-[15px] leading-7">
        {node.body.trim() === '' ? (
          <p className="text-muted-foreground">Nothing written here yet.</p>
        ) : (
          node.body.split(/\n{2,}/).map((para, i) => (
            <p key={i} className="whitespace-pre-wrap">
              {para}
            </p>
          ))
        )}
      </section>

      <section aria-label="Linked pages" className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <LinkRoundIcon className="size-4" aria-hidden />
          Linked pages
        </h3>
        {edges.length === 0 ? (
          <p className="text-sm text-muted-foreground">No links yet.</p>
        ) : (
          <ul className="space-y-0.5">
            {edges.map((e) => {
              const other = e.from === node.key ? e.to : e.from;
              const verb = e.from === node.key ? e.relation : `${e.relation} (from)`;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(other)}
                    aria-label={`${verb} ${titleOf.get(other) ?? other}`}
                    className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-slate-a3"
                  >
                    <span className="w-24 shrink-0 text-xs text-muted-foreground">{verb}</span>
                    <span className="truncate underline decoration-slate-a6 underline-offset-2">
                      {titleOf.get(other) ?? other}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="History" className="space-y-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <HistoryIcon className="size-4" aria-hidden />
          History
        </h3>
        <ol className="space-y-2 border-l border-border pl-4">
          {versions.map((v) => (
            <li key={v.id} className="space-y-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium tabular-nums">v{v.version}</span>
                <Commit version={v} repo={repo} />
                <span className="text-muted-foreground">{v.author}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {when(v.createdAt)} on {v.branch}
                {typeof v.snapshot.title === 'string' && v.snapshot.title !== node.title
                  ? ` · titled "${v.snapshot.title}"`
                  : ''}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
