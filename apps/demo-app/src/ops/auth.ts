import { createHash, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config.ts';

// A shorter secret is treated as unset, so a placeholder can't open the ops API.
export const MIN_SECRET_LENGTH = 32;

export function opsError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Checks the `Authorization: Bearer <OPS_SECRET>` header. Returns the error response to
 * send, or null when the caller holds the secret. Only the orchestrator holds it; with no
 * secret set the ops API is off. Hashes are compared so the check takes the same time
 * whatever the length or content of the guess.
 */
export function checkOpsAuth(request: Request, env: Env): Response | null {
  const secret = env.OPS_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return opsError(503, 'ops_disabled', 'OPS_SECRET is not set on this deployment');
  }
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  if (!match?.[1] || !timingSafeEqual(digest(match[1]), digest(secret))) {
    return opsError(401, 'unauthorized', 'Expected Authorization: Bearer <OPS_SECRET>');
  }
  return null;
}

/**
 * Reads `?dryRun=true|false` (default false). Any other query parameter or value is
 * rejected, so a misspelt dry run can't make a real change.
 */
export function readDryRun(request: Request): boolean | Response {
  const params = new URL(request.url).searchParams;
  const bad = () => opsError(400, 'bad_request', 'The only query parameter is dryRun=true|false');
  for (const name of params.keys()) if (name !== 'dryRun') return bad();
  const values = params.getAll('dryRun');
  if (values.length === 0) return false;
  if (values.length > 1 || (values[0] !== 'true' && values[0] !== 'false')) return bad();
  return values[0] === 'true';
}
