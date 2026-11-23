import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { deciderFor, ISSUE_EVENT_ACTORS } from '@page/contracts';
import type { Caller } from './api-tokens.ts';

/**
 * How the record names a caller: `ui:<name>` for a person, as their Tier 3 decisions are, and
 * `api:shared` for the shared token.
 */
export function actorOf(caller: Caller): string {
  return caller.kind === 'person' ? deciderFor(caller.name) : ISSUE_EVENT_ACTORS.sharedToken;
}

const callers = new WeakMap<object, Caller>();

/** Keeps who sent `request`, for CallerOf. ApiTokenGuard calls it once the token passes. */
export function setCaller(request: object, caller: Caller): void {
  callers.set(request, caller);
}

/** Who sent `request`, or undefined when no guard checked its token. */
export function callerOf(request: object): Caller | undefined {
  return callers.get(request);
}

/**
 * A route parameter: who sent the request, from the token ApiTokenGuard checked. Undefined
 * only on a route that skips the guard.
 */
export const CallerOf = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Caller | undefined =>
    callerOf(context.switchToHttp().getRequest<object>()),
);
