import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * `Authorization: Bearer <POSTHOG_WEBHOOK_SECRET>`. Missing config rejects everyone, so an
 * empty secret cannot be guessed. The hashes are compared so the check takes the same time
 * whatever the guess contains.
 */
export function webhookAuthorized(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  const token = match?.[1];
  if (!token) return false;
  return timingSafeEqual(digest(token), digest(secret));
}
