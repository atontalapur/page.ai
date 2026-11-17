import { createHash, timingSafeEqual } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * `Authorization: Bearer <secret>`. Missing config rejects everyone, so an empty secret
 * cannot be guessed. The hashes are compared so the check takes the same time whatever the
 * guess contains.
 */
export function bearerAuthorized(
  authorization: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret) return false;
  const match = /^Bearer (.+)$/.exec(authorization ?? '');
  const token = match?.[1];
  if (!token) return false;
  return timingSafeEqual(digest(token), digest(secret));
}

/** The request's `Authorization` header, for a guard to pass to bearerAuthorized. */
export function authorizationHeader(context: ExecutionContext): string | undefined {
  const request = context.switchToHttp().getRequest<{
    headers: { authorization?: string | string[] };
  }>();
  const header = request.headers.authorization;
  return Array.isArray(header) ? header[0] : header;
}
