// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';

import KnowledgePage from './KnowledgePage';
import { renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const node = (key: string, title: string, body = '') => ({
  id: key,
  branch: 'main',
  key,
  kind: 'file',
  title,
  body,
  version: 2,
  updatedAt: '2026-11-23T10:00:00.000Z',
});
const cart = node('file:cart.ts', 'Cart totals', 'Sums the lines.\n\nRounds at the end.');
const money = node('file:money.ts', 'Money format');
const edge = {
  id: 'e1',
  branch: 'main',
  from: 'file:cart.ts',
  to: 'file:money.ts',
  relation: 'imports',
};
const version = (v: number, sha: string | null) => ({
  id: String(v),
  branch: 'main',
  version: v,
  snapshot: { title: 'Cart totals' },
  runId: null,
  author: v === 2 ? 'agent:tier1' : 'seed:main',
  createdAt: '2026-11-23T10:00:00.000Z',
  commitSha: sha,
  pushedAt: sha ? '2026-11-23T10:00:00.000Z' : null,
});

function orchestrator() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const json = (body: unknown) => Promise.resolve(Response.json(body));
      if (url.startsWith('/kg/branches')) {
        return json([{ name: 'main', versions: 3, unpushed: 1, updatedAt: null }]);
      }
      if (url.startsWith('/kg/graph')) {
        return json({ branch: 'main', repo: 'o/page-demo', nodes: [cart, money], edges: [edge] });
      }
      if (url.startsWith('/kg/node')) {
        return json({
          node: cart,
          versions: [version(2, null), version(1, 'a'.repeat(40))],
          edges: [edge],
          linked: [money],
        });
      }
      if (url.startsWith('/kg/search')) {
        return json({
          branch: 'main',
          query: 'cart',
          matches: [{ node: cart, score: 0.9 }],
          neighbors: [money],
          edges: [edge],
        });
      }
      return Promise.resolve(Response.json({}, { status: 404 }));
    }),
  );
  return calls;
}

describe('KnowledgePage', () => {
  it('lists the pages the branch sees, with counts under the graph', async () => {
    orchestrator();
    renderWithIssues(<KnowledgePage />, testSource([]));
    const pages = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('button', { name: 'Cart totals' })).toBeTruthy();
    expect(await screen.findByText(/2 pages · 1 links · 1 not pushed/)).toBeTruthy();
  });

  it('opens a page like Notion: title, properties, text, links, and history with commits', async () => {
    orchestrator();
    renderWithIssues(<KnowledgePage />, testSource([]));
    fireEvent.click(await screen.findByRole('button', { name: 'Cart totals' }));

    expect(await screen.findByRole('heading', { name: 'Cart totals', level: 2 })).toBeTruthy();
    expect(screen.getByText('Rounds at the end.')).toBeTruthy();
    const linked = screen.getByRole('region', { name: 'Linked pages' });
    expect(within(linked).getByRole('button', { name: /imports Money format/ })).toBeTruthy();
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText('not pushed')).toBeTruthy();
    expect(within(history).getByRole('link', { name: 'aaaaaaa' }).getAttribute('href')).toBe(
      `https://github.com/o/page-demo/commit/${'a'.repeat(40)}`,
    );
  });

  it('searches by meaning and opens the best match', async () => {
    const calls = orchestrator();
    renderWithIssues(<KnowledgePage />, testSource([]));
    fireEvent.change(await screen.findByLabelText('Search the knowledge graph'), {
      target: { value: 'cart' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('heading', { name: 'Cart totals', level: 2 })).toBeTruthy();
    expect(calls).toContain('POST /kg/search');
  });
});
