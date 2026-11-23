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
  return tokenAuthorized(bearerToken(authorization), secret);
}

/** The token in `Bearer <token>`, or undefined for no header or one of another shape. */
export function bearerToken(authorization: string | undefined): string | undefined {
  return /^Bearer (.+)$/.exec(authorization ?? '')?.[1];
}

/**
 * The secret itself, for a caller that can't send headers: a browser's Socket.IO handshake
 * carries it as `auth.token`. The same rules as bearerAuthorized.
 */
export function tokenAuthorized(token: unknown, secret: string | undefined): boolean {
  if (!secret || typeof token !== 'string' || !token) return false;
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
