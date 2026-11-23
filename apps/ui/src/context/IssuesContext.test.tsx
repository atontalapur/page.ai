// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ConnectionBadge from '../components/issues/ConnectionBadge';
import SignedInAs from '../components/issues/SignedInAs';
import TokenPrompt from '../components/issues/TokenPrompt';
import { issue, testSource, withSession, type TestSource } from '../test-utils';
import { IssuesProvider, useIssues } from './IssuesContext';

interface FakeServer {
  present: boolean;
  sources: { token: string; source: TestSource }[];
  status: 'live' | 'needs_token';
}

const server = vi.hoisted((): FakeServer => ({ present: false, sources: [], status: 'live' }));

vi.mock('../live/server-source', async () => {
  const utils = await import('../test-utils');
  return {
    serverPresent: () => Promise.resolve(server.present),
    serverSource: (token: string) => {
      const source = utils.testSource([utils.issue(7)], server.status);
      server.sources.push({ token, source });
      return source;
    },
  };
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  server.present = false;
  server.sources.length = 0;
  server.status = 'live';
});

function Count() {
  const { issues } = useIssues();
  return <p>{issues.length} issues</p>;
}

function renderApp(source?: TestSource) {
  return render(
    <IssuesProvider source={source}>
      <ConnectionBadge />
      <TokenPrompt />
      <Count />
    </IssuesProvider>,
  );
}

describe('IssuesProvider', () => {
  it('plays the mock source when no orchestrator served the page', async () => {
    renderApp();

    expect(screen.getByText('Connecting')).toBeTruthy();
    expect(await screen.findByText('Mock data')).toBeTruthy();
    expect(screen.getByText('4 issues')).toBeTruthy();
    expect(server.sources).toEqual([]);
  });

  it('asks for the token, then connects with it and keeps it for the tab', async () => {
    server.present = true;
    renderApp();

    fireEvent.change(await screen.findByLabelText('Personal or API token'), {
      target: { value: ' s3cret ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByText('Live')).toBeTruthy();
    expect(server.sources.map((s) => s.token)).toEqual(['s3cret']);
    expect(sessionStorage.getItem('page-ai-api-token')).toBe('s3cret');
    expect(screen.getByText('1 issues')).toBeTruthy();
    expect(screen.queryByLabelText('Personal or API token')).toBeNull();
  });

  it('connects with a token kept from earlier in the tab', async () => {
    server.present = true;
    sessionStorage.setItem('page-ai-api-token', 'kept');
    renderApp();

    expect(await screen.findByText('Live')).toBeTruthy();
    expect(server.sources.map((s) => s.token)).toEqual(['kept']);
  });

  it('forgets a refused token and asks again', async () => {
    server.present = true;
    server.status = 'needs_token';
    sessionStorage.setItem('page-ai-api-token', 'stale');
    renderApp();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('The orchestrator refused that token.')).toBeTruthy();
    expect(screen.getByText('Token needed')).toBeTruthy();
    expect(sessionStorage.getItem('page-ai-api-token')).toBeNull();
  });

  it('shows who a personal token signs in, and forgets it with the token', async () => {
    const source = withSession(testSource([issue(1)]), { token: 'personal', name: 'Nidheesh' });
    let signOut: () => void = () => undefined;
    function SignOut() {
      signOut = useIssues().signOut;
      return null;
    }
    sessionStorage.setItem('page-ai-api-token', 'personal');
    render(
      <IssuesProvider source={source}>
        <SignedInAs />
        <TokenPrompt />
        <SignOut />
      </IssuesProvider>,
    );

    expect((await screen.findByText(/^Signed in as/)).textContent).toBe('Signed in as Nidheesh');
    act(() => signOut());
    expect(screen.queryByText(/^Signed in as/)).toBeNull();
    expect(screen.getByLabelText('Personal or API token')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sessionStorage.getItem('page-ai-api-token')).toBeNull();
  });

  it('shows no one signed in for the shared token or the mock', async () => {
    const shared = withSession(testSource([issue(1)]), { token: 'shared', canDecide: true });
    const asked = vi.spyOn(shared, 'fetchSession');
    render(
      <IssuesProvider source={shared}>
        <SignedInAs />
        <Count />
      </IssuesProvider>,
    );
    await waitFor(() => expect(asked).toHaveBeenCalled());
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    cleanup();
    renderApp();
    expect(await screen.findByText('Mock data')).toBeTruthy();
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('shows a source losing its connection', () => {
    const source = testSource([issue(1)]);
    renderApp(source);

    expect(screen.getByText('Live')).toBeTruthy();
    source.setStatus('reconnecting');
    expect(screen.getByText('Reconnecting')).toBeTruthy();
  });

  it('is required by useIssues', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Count />)).toThrow('useIssues must be used inside IssuesProvider');
  });
});
