import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { authorizationHeader, bearerAuthorized } from '../auth/bearer.ts';
import type { Config } from '../config.ts';
import { CONFIG } from '../tokens.ts';

@Injectable()
export class PosthogWebhookGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    if (!bearerAuthorized(authorizationHeader(context), this.config.posthogWebhookSecret)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
