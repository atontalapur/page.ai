import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { SkipApiToken } from '../auth/api-token.guard.ts';
import { NodeSecretGuard } from '../knowledge/knowledge.controller.ts';
import { RateLimitGuard } from '../rate-limit.guard.ts';
import { GitHubAppError, GitHubAppService } from './github-app.service.ts';

async function asHttp<T>(work: Promise<T> | (() => T)): Promise<T> {
  try {
    return await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (error instanceof GitHubAppError) throw new BadRequestException(error.message);
    throw error;
  }
}

/** The dashboard's Settings: create the agents' GitHub App, and see where it is installed. */
@Controller('github/app')
@UseGuards(new RateLimitGuard(30, 60_000))
export class GitHubAppController {
  constructor(private readonly app: GitHubAppService) {}

  @Get()
  status() {
    return this.app.status();
  }

  /** The manifest the dashboard posts to GitHub to create the app. */
  @Post('manifest')
  @HttpCode(200)
  manifest() {
    return asHttp(() => this.app.manifest());
  }
}

/**
 * Where GitHub sends the browser after creating and after installing the app. The browser
 * carries no API token here: creation is bound to the state the manifest was issued with,
 * and an installation is checked against GitHub with the app's own key.
 */
@Controller('github/app')
@SkipApiToken()
@UseGuards(new RateLimitGuard(20, 60_000))
export class GitHubAppRedirectController {
  constructor(private readonly app: GitHubAppService) {}

  @Get('callback')
  async callback(
    @Query('code', { schema: z.string().min(1).max(200) }) code: string,
    @Query('state', { schema: z.string().regex(/^[0-9a-f]{48}$/) }) state: string,
    @Res() reply: FastifyReply,
  ) {
    const install = await asHttp(this.app.created(code, state));
    return reply.redirect(install, 302);
  }

  @Get('setup')
  async setup(
    @Query('installation_id', { schema: z.coerce.number().int().positive() }) id: number,
    @Res() reply: FastifyReply,
  ) {
    const repo = await asHttp(this.app.installed(id));
    return reply.redirect(`/settings?github=${encodeURIComponent(repo)}`, 302);
  }
}

/** The node's GitHub token for a run: the app's installation token, minted here. */
@Controller('github')
@SkipApiToken()
@UseGuards(NodeSecretGuard, new RateLimitGuard(120, 60_000))
export class GitHubTokenController {
  constructor(private readonly app: GitHubAppService) {}

  @Get('token')
  async token() {
    const token = await asHttp(this.app.token());
    if (!token) throw new NotFoundException('No GitHub App is installed; use GITHUB_TOKEN');
    return token;
  }
}
