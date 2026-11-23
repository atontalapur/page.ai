import { gitHubAppStatusSchema, type GitHubAppStatus } from '@page/contracts';

import { readToken } from './token';

const headers = () => ({
  authorization: `Bearer ${readToken() ?? ''}`,
  accept: 'application/json',
});

/** The agents' GitHub identity: the app, if one was created, and where it is installed. */
export async function loadGitHubApp(): Promise<GitHubAppStatus> {
  const res = await fetch('/github/app', { headers: headers() });
  if (!res.ok) throw new Error(`The orchestrator answered ${res.status}.`);
  return gitHubAppStatusSchema.parse(await res.json());
}

/**
 * Starts GitHub's app-manifest flow: posts the orchestrator's manifest to GitHub in a form,
 * which takes the browser there to name and create the app.
 */
export async function createGitHubApp(): Promise<void> {
  const res = await fetch('/github/app/manifest', { method: 'POST', headers: headers() });
  const body = (await res.json().catch(() => ({}))) as {
    action?: string;
    manifest?: string;
    message?: string;
  };
  if (!res.ok || !body.action || !body.manifest) {
    throw new Error(body.message ?? `The orchestrator answered ${res.status}.`);
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = body.action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = body.manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}
