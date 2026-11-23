import {
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clientAddress } from '../rate-limit.ts';
import { ApiTokens } from './api-tokens.ts';
import { authorizationHeader, bearerToken } from './bearer.ts';
import { setCaller } from './caller.ts';

const SKIP_API_TOKEN = 'skipApiToken';

/**
 * Exempts a controller or route from the API token: `/health`, which Railway probes, and
 * `/ingest/posthog`, which checks PostHog's own secret.
 */
export const SkipApiToken = () => SetMetadata(SKIP_API_TOKEN, true);

/**
 * Registered globally, so every route needs `Authorization: Bearer <token>` unless it is
 * marked SkipApiToken. The token is ORCHESTRATOR_API_TOKEN or a person's dashboard token
 * (ApiTokens), and the route can read who sent it with CallerOf. No token or a wrong one gets
 * 401, and an address past its wrong tokens gets 429 with `Retry-After`. With no token
 * configured at all, every such route returns 401.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    private readonly tokens: ApiTokens,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_API_TOKEN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const address = clientAddress(request.socket.remoteAddress, request.headers['x-forwarded-for']);
    const check = this.tokens.check(bearerToken(authorizationHeader(context)), address);
    if (check.ok) {
      setCaller(request, check.caller);
      return true;
    }
    if (check.refusal === 'rate_limited') {
      const seconds = Math.ceil(check.retryAfterMs / 1000);
      http.getResponse<FastifyReply>().header('retry-after', String(seconds));
      throw new HttpException(
        'too many wrong tokens from this address',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw new UnauthorizedException();
  }
}
