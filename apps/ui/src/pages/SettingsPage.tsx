import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircleIcon, SquareShareLineIcon } from '@solar-icons/react/bold-duotone';
import type { GitHubAppStatus } from '@page/contracts';
import { Button, buttonVariants } from '@page/design-system/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';

import TokenPrompt from '../components/issues/TokenPrompt';
import { useIssues } from '../context/IssuesContext';
import { createGitHubApp, loadGitHubApp } from '../live/github';

/** The agents' GitHub App: create it, install it on the demo repo, and see who PRs come from. */
function GitHubCard() {
  const [status, setStatus] = useState<GitHubAppStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(() => {
    loadGitHubApp().then(setStatus, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);
  useEffect(refresh, [refresh]);

  async function create() {
    setStarting(true);
    setError(undefined);
    try {
      await createGitHubApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStarting(false);
    }
  }

  const app = status?.app;
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle>GitHub</CardTitle>
        <p className="max-w-prose text-sm text-muted-foreground">
          The agents push their fixes and open PRs as a GitHub App, so the PRs come from a bot and
          you can approve them or request changes. Reviews on those PRs decide the fix.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {status === undefined && !error && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}

        {status && !app && (
          <div className="space-y-2">
            <Button onClick={() => void create()} disabled={starting || !status.canCreate}>
              {starting ? 'Opening GitHub…' : 'Create GitHub App'}
            </Button>
            {!status.canCreate && (
              <p className="text-sm text-muted-foreground">
                Set <code className="font-mono text-xs">SECRETS_KEY</code> on the orchestrator
                first; it encrypts the app&apos;s private key.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              GitHub opens with the app filled in: its permissions, and the webhook back to this
              dashboard. Name it and create it, then install it on the demo repo.
            </p>
          </div>
        )}

        {app && !app.installed && (
          <div className="space-y-2">
            <p className="text-sm">
              <span className="font-medium">{app.slug}</span> is created. Install it on the demo
              repo to finish.
            </p>
            <a href={app.installUrl} className={buttonVariants({ variant: 'default' })}>
              <SquareShareLineIcon className="size-4" aria-hidden />
              Install on GitHub
            </a>
          </div>
        )}

        {app?.installed && (
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">PRs come from</dt>
              <dd className="flex items-center gap-1.5 font-medium">
                <CheckCircleIcon className="size-4 text-green-11" aria-hidden />
                {app.bot}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Repository</dt>
              <dd className="font-mono text-xs">{app.repo}</dd>
            </div>
            <div className="sm:col-span-2">
              <a
                href={app.url}
                target="_blank"
                rel="noreferrer"
                className="text-sm underline underline-offset-2"
              >
                Open the app on GitHub
              </a>
            </div>
          </dl>
        )}

        {status?.fallback && !app?.installed && (
          <p className="rounded-md bg-amber-a2 px-3 py-2 text-sm text-amber-11">
            Until the app is installed, the agents use the personal token in GITHUB_TOKEN for{' '}
            <span className="font-mono text-xs">{status.fallback.repo}</span>, so its PRs are yours
            and GitHub only lets you comment on them. Comment <code>/approve</code> or{' '}
            <code>/reject</code> to decide.
          </p>
        )}

        {error && (
          <p role="alert" className="text-sm text-red-11">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { status } = useIssues();
  const [params] = useSearchParams();
  const installedOn = params.get('github');
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">Settings</h2>
      </div>
      <TokenPrompt />
      {installedOn && (
        <p role="status" className="rounded-md bg-green-a3 px-3 py-2 text-sm text-green-11">
          The GitHub App is installed on {installedOn}. New fixes open their PRs from it.
        </p>
      )}
      {status === 'needs_token' ? null : <GitHubCard />}
    </div>
  );
}
