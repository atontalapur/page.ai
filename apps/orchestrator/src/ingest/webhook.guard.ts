import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Config } from '../config.ts';
import { CONFIG } from '../tokens.ts';
import { webhookAuthorized } from './auth.ts';

@Injectable()
export class PosthogWebhookGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string | string[] };
    }>();
    const header = request.headers.authorization;
    const authorization = Array.isArray(header) ? header[0] : header;
    if (!webhookAuthorized(authorization, this.config.posthogWebhookSecret)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
