import { randomUUID } from 'node:crypto';
import { HashEmbedder } from '@page/model-client';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDeps } from '../db/test-utils.ts';
import { IssuesService } from '../issues/issues.service.ts';
import type { GitHubApi } from '../github/github-api.ts';
import { KgRefusedError, KnowledgeService, runBranch } from './knowledge.service.ts';
import { describeFile, seedMain } from './seed.ts';

const deps = await createTestDeps();
afterAll(() => deps.close());

const kg = new KnowledgeService(deps.db, new HashEmbedder(), deps.logger, deps.config);
const agent = (runId: string) => ({ runId, author: 'agent:tier1' });
const SHA = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);

const cart = { key: 'file:cart.ts', kind: 'file', title: 'Cart totals', body: 'sums line items' };

describe('KnowledgeService', () => {
  it("reads a run's branch over main, and writes only to the run's branch", async () => {
    await kg.writeNode(
      'main',
      { ...cart, key: 'file:main-only.ts' },
      { runId: null, author: 'seed' },
    );
    const runId = randomUUID();
    const branch = runBranch(runId);
    await kg.writeNode(branch, { ...cart, body: 'sums line items and shipping' }, agent(runId));

    const onRun = await kg.graph(branch);
    expect(onRun.nodes.map((n) => n.key)).toEqual(
      expect.arrayContaining(['file:cart.ts', 'file:main-only.ts']),
    );
    expect(onRun.nodes.find((n) => n.key === 'file:cart.ts')?.body).toBe(
      'sums line items and shipping',
    );
    expect((await kg.graph('main')).nodes.some((n) => n.key === 'file:cart.ts')).toBe(false);
  });

  it('keeps a version per change, and none for a write that changes nothing', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    await kg.writeNode(branch, cart, agent(runId));
    await kg.writeNode(branch, cart, agent(runId));
    await kg.writeNode(branch, { ...cart, title: 'Cart totals and tax' }, agent(runId));

    const { node, versions } = await kg.node(branch, cart.key);
    expect(node.version).toBe(2);
    expect(versions.map((v) => [v.version, v.snapshot.title])).toEqual([
      [2, 'Cart totals and tax'],
      [1, 'Cart totals'],
    ]);
    expect(versions.every((v) => v.commitSha === null && v.runId === runId)).toBe(true);
  });

  it('stamps a commit only on versions written before it, and never changes it', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    await kg.writeNode(branch, cart, agent(runId));
    expect(await kg.stampCommit(branch, SHA)).toBe(1);
    await kg.writeNode(branch, { ...cart, body: 'after the push' }, agent(runId));

    const { versions } = await kg.node(branch, cart.key);
    expect(versions.map((v) => v.commitSha)).toEqual([null, SHA]);
    await expect(
      sql`update kg_versions set commit_sha = ${MERGE} where commit_sha = ${SHA}`.execute(deps.db),
    ).rejects.toThrow(/already/);
  });

  it('takes parallel writes to one node without locks: every change a version, none lost', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    const bodies = Array.from({ length: 6 }, (_, i) => `draft ${i}`);
    await Promise.all(bodies.map((body) => kg.writeNode(branch, { ...cart, body }, agent(runId))));

    const { node, versions } = await kg.node(branch, cart.key);
    expect(versions.map((v) => v.version)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(new Set(versions.map((v) => v.snapshot.body))).toEqual(new Set(bodies));
    expect(node.body).toBe(versions[0]?.snapshot.body);
  });

  it('writes a link once when two writers race to add it', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    const by = agent(runId);
    await kg.writeNode(branch, { ...cart, key: 'file:x.ts' }, by);
    await kg.writeNode(branch, { ...cart, key: 'file:y.ts' }, by);
    const link = { from: 'file:x.ts', to: 'file:y.ts', relation: 'imports' };
    const [a, b] = await Promise.all([
      kg.writeEdge(branch, link, by),
      kg.writeEdge(branch, link, by),
    ]);
    expect(a.id).toBe(b.id);
  });

  it('refuses a link to a node the branch cannot see', async () => {
    const runId = randomUUID();
    await kg.writeNode(runBranch(runId), cart, agent(runId));
    await expect(
      kg.writeEdge(
        runBranch(runId),
        { from: cart.key, to: 'file:nowhere.ts', relation: 'imports' },
        agent(runId),
      ),
    ).rejects.toBeInstanceOf(KgRefusedError);
  });

  it('searches by meaning, then brings in the linked nodes', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    const by = agent(runId);
    await kg.writeNode(
      branch,
      {
        key: 'file:ship.ts',
        kind: 'file',
        title: 'Shipping cost',
        body: 'flat shipping cents setting',
      },
      by,
    );
    await kg.writeNode(
      branch,
      { key: 'file:money.ts', kind: 'file', title: 'Money format', body: 'currency formatting' },
      by,
    );
    await kg.writeEdge(
      branch,
      { from: 'file:ship.ts', to: 'file:money.ts', relation: 'imports' },
      by,
    );

    const result = await kg.search(branch, 'shipping cents', 1);
    expect(result.matches[0]?.node.key).toBe('file:ship.ts');
    expect(result.neighbors.map((n) => n.key)).toContain('file:money.ts');
    expect(result.edges).toMatchObject([
      { from: 'file:ship.ts', relation: 'imports', to: 'file:money.ts' },
    ]);
  });

  it('copies a merged branch onto main with the merge commit', async () => {
    const runId = randomUUID();
    const branch = runBranch(runId);
    await kg.writeNode(branch, { ...cart, key: 'file:merged.ts' }, agent(runId));
    await kg.promote(branch, MERGE, 'github:reviewer');

    const { node, versions } = await kg.node('main', 'file:merged.ts');
    expect(node.branch).toBe('main');
    expect(versions[0]).toMatchObject({ commitSha: MERGE, author: 'github:reviewer', runId });
  });
});

describe("knowledge across an issue's tiers", () => {
  it("lets a later tier read what the tier below wrote, but not another issue's runs", async () => {
    const issues = new IssuesService(deps.db, deps.fixJobs, deps.logger);
    const { issue } = await issues.report(
      { fingerprint: `kg-tiers-${randomUUID()}`, title: 'Boom' },
      'Error',
    );
    await issues.apply(issue.id, { type: 'triage', class: 'backend-api', severity: 'high' });
    await issues.apply(issue.id, { type: 'start_fix' });
    const current = await deps.db
      .selectFrom('issues')
      .select('current_run_id')
      .where('id', '=', issue.id)
      .executeTakeFirstOrThrow();
    // The Tier 1 run before it, recorded when it escalated.
    const tier1 = randomUUID();
    await deps.db
      .insertInto('runs')
      .values({
        id: tier1,
        issue_id: issue.id,
        tier: 1,
        status: 'escalated',
        started_at: new Date(Date.now() - 60_000),
        finished_at: new Date(),
      })
      .execute();
    await kg.writeNode(
      runBranch(tier1),
      { ...cart, key: 'file:found-at-tier1.ts', body: 'the setting has no upper bound' },
      agent(tier1),
    );

    const later = runBranch(current.current_run_id!);
    expect(await kg.chain(later)).toEqual([later, runBranch(tier1), 'main']);
    expect((await kg.node(later, 'file:found-at-tier1.ts')).node.body).toBe(
      'the setting has no upper bound',
    );
    const stranger = runBranch(randomUUID());
    expect((await kg.graph(stranger)).nodes.some((n) => n.key === 'file:found-at-tier1.ts')).toBe(
      false,
    );
  });
});

describe('seedMain', () => {
  it('describes a file by its doc comment, exports and imports', () => {
    const file = describeFile(
      'apps/demo-app/src/shop/cart.ts',
      "import { price } from './money.ts';\n/** The cart. */\nexport function total() {}\nexport const MAX = 3;\n",
    );
    expect(file).toMatchObject({ kind: 'file', title: 'shop/cart.ts', imports: ['./money.ts'] });
    expect(file.body).toContain('The cart.');
    expect(file.body).toContain('Exports: total, MAX.');
  });

  it("seeds main from the repo's head, linked by imports and stamped with that commit", async () => {
    const head = 'c'.repeat(40);
    const blobs: Record<string, string> = {
      a: "import { b } from './b.ts';\nexport function a() {}\n",
      b: 'export function b() {}\n',
      t: "import { a } from './a.ts';\n",
    };
    const github: Pick<GitHubApi, 'head' | 'files' | 'text'> = {
      head: () => Promise.resolve(head),
      files: () =>
        Promise.resolve([
          { path: 'apps/demo-app/src/seed/a.ts', sha: 'a', size: 10 },
          { path: 'apps/demo-app/src/seed/b.ts', sha: 'b', size: 10 },
          { path: 'apps/demo-app/src/seed/a.test.ts', sha: 't', size: 10 },
          { path: 'README.md', sha: 'r', size: 10 },
        ]),
      text: (sha) => Promise.resolve(blobs[sha] ?? ''),
    };
    const result = await seedMain(github as unknown as GitHubApi, kg, 'seed:main');
    expect(result).toMatchObject({ commit: head, nodes: 3, edges: 2 });

    const { node, versions, edges } = await kg.node('main', 'file:apps/demo-app/src/seed/a.ts');
    expect(node.kind).toBe('file');
    expect(versions[0]?.commitSha).toBe(head);
    expect(edges.map((e) => `${e.from} ${e.relation} ${e.to}`)).toEqual(
      expect.arrayContaining([
        'file:apps/demo-app/src/seed/a.ts imports file:apps/demo-app/src/seed/b.ts',
        'file:apps/demo-app/src/seed/a.test.ts tests file:apps/demo-app/src/seed/a.ts',
      ]),
    );
  });
});
