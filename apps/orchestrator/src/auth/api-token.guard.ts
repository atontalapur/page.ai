import {
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Config } from '../config.ts';
import { CONFIG } from '../tokens.ts';
import { authorizationHeader, bearerAuthorized } from './bearer.ts';

const SKIP_API_TOKEN = 'skipApiToken';

/**
 * Exempts a controller or route from the API token: `/health`, which Railway probes, and
 * `/ingest/posthog`, which checks PostHog's own secret.
 */
export const SkipApiToken = () => SetMetadata(SKIP_API_TOKEN, true);

/**
 * Registered globally, so every route needs `Authorization: Bearer <ORCHESTRATOR_API_TOKEN>`
 * unless it is marked SkipApiToken. With the token unset every such route returns 401.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(SKIP_API_TOKEN, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    if (!bearerAuthorized(authorizationHeader(context), this.config.apiToken)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
