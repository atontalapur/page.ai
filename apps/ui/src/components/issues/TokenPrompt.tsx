import { useState, type FormEvent } from 'react';
import { KeyMinimalisticIcon } from '@solar-icons/react/linear';

import { Button } from '@page/design-system/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@page/design-system/components/ui/card';
import { Input } from '@page/design-system/components/ui/input';
import { Label } from '@page/design-system/components/ui/label';

import { useIssues } from '../../context/IssuesContext';

/**
 * Asks for ORCHESTRATOR_API_TOKEN when the orchestrator has none for this tab, or refused
 * the one it had. Renders nothing otherwise.
 */
export default function TokenPrompt() {
  const { status, tokenRefused, submitToken } = useIssues();
  const [token, setToken] = useState('');

  if (status !== 'needs_token') return null;

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (value) submitToken(value);
    setToken('');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyMinimalisticIcon className="size-5" />
          Connect to the orchestrator
        </CardTitle>
        <CardDescription>
          Issues come from the orchestrator API, which needs its token. It stays in this tab and is
          cleared when the tab closes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="api-token">API token</Label>
            <Input
              id="api-token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              aria-invalid={tokenRefused || undefined}
              aria-describedby={tokenRefused ? 'api-token-error' : undefined}
            />
          </div>
          <Button type="submit" disabled={!token.trim()}>
            Connect
          </Button>
        </form>
        {tokenRefused && (
          <p id="api-token-error" role="alert" className="mt-2 text-sm text-destructive">
            The orchestrator refused that token.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
