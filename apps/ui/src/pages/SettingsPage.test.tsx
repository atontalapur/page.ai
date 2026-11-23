// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';

import SettingsPage from './SettingsPage';
import { renderWithIssues, testSource } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(status: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(status))),
  );
}

const app = {
  slug: 'pageagents-1a2b',
  url: 'https://github.com/apps/pageagents-1a2b',
  owner: 'nidheesh',
  bot: 'pageagents-1a2b[bot]',
  installed: false,
  repo: null,
  installUrl: 'https://github.com/apps/pageagents-1a2b/installations/new',
};

describe('SettingsPage', () => {
  it('offers to create the app, and says why it cannot without SECRETS_KEY', async () => {
    serve({ canCreate: false, app: null, fallback: { repo: 'o/page-demo' } });
    renderWithIssues(<SettingsPage />, testSource([]));
    const button = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Create GitHub App',
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('SECRETS_KEY')).toBeTruthy();
    expect(screen.getByText(/only lets you comment/)).toBeTruthy();
  });

  it('links to installing a created app', async () => {
    serve({ canCreate: true, app, fallback: null });
    renderWithIssues(<SettingsPage />, testSource([]));
    const link = await screen.findByRole('link', { name: 'Install on GitHub' });
    expect(link.getAttribute('href')).toBe(app.installUrl);
  });

  it('shows the bot PRs come from once it is installed', async () => {
    serve({
      canCreate: true,
      app: { ...app, installed: true, repo: 'o/page-demo' },
      fallback: null,
    });
    renderWithIssues(<SettingsPage />, testSource([]));
    expect(await screen.findByText('pageagents-1a2b[bot]')).toBeTruthy();
    expect(screen.getByText('o/page-demo')).toBeTruthy();
  });
});
