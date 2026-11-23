import { useCallback, useEffect, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import {
  CartLargeIcon,
  CodeIcon,
  RefreshIcon,
  RestartIcon,
  SendSquareIcon,
} from '@solar-icons/react/bold-duotone';
import type { DebugErrorKind, DebugResult, DebugState } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';
import { Button } from '@page/design-system/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';

import TokenPrompt from '../components/issues/TokenPrompt';
import { useIssues } from '../context/IssuesContext';
import { createDebugError, loadDebug, plantBug, resetDemoApp, type DebugLoad } from '../live/debug';

interface ErrorOption {
  kind: DebugErrorKind;
  title: string;
  icon: ComponentType<{ className?: string }>;
  what: string;
  /** The parts of the system it runs through, in order. */
  path: string[];
  time: string;
  /** Why it can't run now, or undefined when it can. */
  unavailable: (state: DebugState) => string | undefined;
  /** A box to tick before it runs, for a test that breaks something people use. */
  confirm?: string;
}

// The gentle tests: nothing a shopper relies on breaks, and nothing on the live app changes.
const GENTLE: ErrorOption[] = [
  {
    kind: 'code_bug',
    title: 'Trigger the search bug',
    icon: CodeIcon,
    what: 'Searches the home page for "(", which fails while the planted search bug is live. Only that search breaks; a Tier 1 fix repairs it by PR.',
    path: ['Demo app', 'PostHog', 'Ingest', 'Triage', 'Page', 'Fix at Tier 1'],
    time: 'A few seconds.',
    unavailable: (state) =>
      state.codeBugLive === false ? 'Plant the search bug first, and merge its PR.' : undefined,
  },
  {
    kind: 'synthetic',
    title: 'Send a test exception',
    icon: SendSquareIcon,
    what: 'Sends one exception straight to PostHog. Nothing in the app breaks, so a fix will find nothing to change: use it to check ingest, triage and paging.',
    path: ['PostHog', 'Ingest', 'Triage', 'Page'],
    time: 'A few seconds.',
    unavailable: (state) => (state.canSendSynthetic ? undefined : 'POSTHOG_KEY is not set.'),
  },
];

// Changes a live setting and breaks every order that pays shipping, until it resets.
const CHECKOUT: ErrorOption = {
  kind: 'checkout',
  title: 'Break checkout',
  icon: CartLargeIcon,
  what: 'Sets SHIPPING_FLAT_CENTS past what Postgres stores, restarts the demo app, and places an order, which fails with 500. Tier 3 fixes it by undoing the setting, with your approval for each change to the live app.',
  path: ['Demo app', 'PostHog', 'Ingest', 'Triage', 'Page', 'Fix at Tier 3'],
  time: 'About 20 seconds to break. It resets itself after 15 minutes.',
  unavailable: (state) => (state.healthy ? undefined : 'The demo app is not healthy.'),
  confirm: 'Checkout fails for every order that pays shipping until this resets.',
};

function ResultLine({ result }: { result: DebugResult }) {
  return (
    <div
      role="status"
      className={`space-y-1 rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-green-a3 text-green-11' : 'bg-red-a3 text-red-11'}`}
    >
      <p>{result.message}</p>
      {result.ok && result.url && (
        <a href={result.url} target="_blank" rel="noreferrer" className="font-medium underline">
          Open the PR
        </a>
      )}
      {result.ok && !result.url && (
        <Link to="/incidents" className="font-medium underline">
          Watch it on Incidents
        </Link>
      )}
    </div>
  );
}

function ErrorCard({
  option,
  state,
  onDone,
}: {
  option: ErrorOption;
  state: DebugState;
  onDone: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DebugResult | undefined>();
  const [confirmed, setConfirmed] = useState(false);
  const blocked = option.unavailable(state);
  const Icon = option.icon;

  async function create() {
    setPending(true);
    setResult(undefined);
    try {
      setResult(await createDebugError(option.kind));
    } catch {
      setResult({ ok: false, status: null, message: 'Could not reach the orchestrator.' });
    } finally {
      setPending(false);
      onDone();
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4 text-muted-foreground" />
          {option.title}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{option.what}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol aria-label={`${option.title} runs through`} className="flex flex-wrap gap-1.5">
          {option.path.map((step) => (
            <li key={step}>
              <Badge variant="outline">{step}</Badge>
            </li>
          ))}
        </ol>
        <p className="text-xs text-muted-foreground">{option.time}</p>
        {option.confirm && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 size-4 accent-[var(--violet-9)]"
            />
            {option.confirm}
          </label>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => void create()}
            disabled={
              pending || blocked !== undefined || (option.confirm !== undefined && !confirmed)
            }
          >
            {pending ? 'Creating...' : 'Create error'}
          </Button>
          {blocked && <span className="text-xs text-muted-foreground">{blocked}</span>}
        </div>
        {result && <ResultLine result={result} />}
      </CardContent>
    </Card>
  );
}

/** Opens the PR that plants the search bug, the first step of the Tier 1 test. */
function PlantCard({ onDone }: { onDone: () => void }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<DebugResult | undefined>();

  async function plant() {
    setPending(true);
    setResult(undefined);
    try {
      setResult(await plantBug());
    } catch {
      setResult({ ok: false, status: null, message: 'Could not reach the orchestrator.' });
    } finally {
      setPending(false);
      onDone();
    }
  }

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-sm">
          <CodeIcon className="size-4 text-muted-foreground" />
          Plant the search bug
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Opens a PR on the demo repo that makes the home page search build a regular expression
          from what you type, so searching for &ldquo;(&rdquo; fails. Merge it, wait for the demo
          app to redeploy, then trigger it.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button variant="outline" onClick={() => void plant()} disabled={pending}>
          {pending ? 'Opening the PR...' : 'Plant the bug'}
        </Button>
        {result && <ResultLine result={result} />}
      </CardContent>
    </Card>
  );
}

/**
 * Test errors for the whole pipeline on the staging demo app. The orchestrator makes every
 * request, so the ops secret and the PostHog key stay on the server.
 */
export default function DebuggingPage() {
  const { status } = useIssues();
  const [load, setLoad] = useState<DebugLoad | undefined>();
  const [resetting, setResetting] = useState(false);
  const [reset, setReset] = useState<DebugResult | undefined>();

  const refresh = useCallback(() => {
    void loadDebug().then(setLoad);
  }, []);
  useEffect(() => {
    if (status !== 'needs_token') refresh();
  }, [refresh, status]);

  async function resetApp() {
    setResetting(true);
    setReset(undefined);
    try {
      setReset(await resetDemoApp());
    } finally {
      setResetting(false);
      refresh();
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-2xl font-bold tracking-tight">Debugging</h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Create errors on the staging demo app to test the whole pipeline. Each one pages on-call,
          and with automatic fixes on, starts a fix that uses model credit.
        </p>
      </div>

      <TokenPrompt />

      {status === 'needs_token' ? null : load === undefined ? (
        <p className="text-sm text-muted-foreground">Loading the demo app...</p>
      ) : load.kind !== 'state' ? (
        <Card>
          <CardContent className="space-y-1 py-4">
            <p className="text-sm font-medium">
              {load.kind === 'off'
                ? 'Debugging is off on this orchestrator'
                : 'Could not load the demo app'}
            </p>
            <p className="text-sm text-muted-foreground">{load.message}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <CardTitle className="text-sm">Demo app</CardTitle>
              <Button variant="outline" size="sm" onClick={refresh}>
                <RefreshIcon className="size-4" />
                Refresh
              </Button>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Address</dt>
                  <dd className="truncate font-mono text-xs" title={load.state.demoAppUrl}>
                    {load.state.demoAppUrl}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Health</dt>
                  <dd>
                    <Badge
                      variant="outline"
                      className={
                        load.state.healthy ? 'bg-green-a3 text-green-11' : 'bg-red-a3 text-red-11'
                      }
                    >
                      {load.state.healthy ? 'Healthy' : 'Not answering'}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Code bug</dt>
                  <dd>
                    {load.state.codeBugLive === null
                      ? 'Unknown'
                      : load.state.codeBugLive
                        ? 'Live'
                        : 'None live'}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Overrides</dt>
                  <dd className="space-y-0.5">
                    {load.state.overrides.length === 0
                      ? 'None'
                      : load.state.overrides.map((o) => (
                          <p key={o.key} className="truncate font-mono text-xs">
                            {o.key}={o.value}
                          </p>
                        ))}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          <section aria-label="Test errors" className="grid gap-4 lg:grid-cols-3">
            <PlantCard onDone={refresh} />
            {GENTLE.map((option) => (
              <ErrorCard key={option.kind} option={option} state={load.state} onDone={refresh} />
            ))}
          </section>

          <details className="space-y-3 rounded-md border border-border p-4">
            <summary className="cursor-pointer text-sm font-medium">
              Advanced: change the live app
              {load.state.checkoutResetAt && (
                <span className="ml-2 font-normal text-muted-foreground">
                  checkout break resets at{' '}
                  {new Date(load.state.checkoutResetAt).toLocaleTimeString(undefined, {
                    timeStyle: 'short',
                  })}
                </span>
              )}
            </summary>
            <div className="max-w-xl pt-3">
              <ErrorCard option={CHECKOUT} state={load.state} onDone={refresh} />
            </div>
          </details>

          <Card>
            <CardHeader className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-sm">
                <RestartIcon className="size-4 text-muted-foreground" />
                Reset the demo app
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Clears every runtime override, including the checkout break, and restarts the app.
                It does not undo a code bug; that lives in page-demo&apos;s main.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" disabled={resetting} onClick={() => void resetApp()}>
                {resetting ? 'Resetting...' : 'Reset the demo app'}
              </Button>
              {reset && <ResultLine result={reset} />}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
