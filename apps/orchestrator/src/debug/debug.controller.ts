import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  debugErrorRequestSchema,
  type DebugErrorRequest,
  type DebugResult,
  type DebugState,
} from '@page/contracts';
import { RateLimitGuard } from '../rate-limit.guard.ts';
import { DebugService, DebugToolsOff } from './debug.service.ts';

// A person clicks these; 20 a minute stops a stuck button from restarting the app in a loop.
export const DEBUG_REQUESTS_PER_MINUTE = 20;

async function orNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof DebugToolsOff) throw new NotFoundException(err.message);
    throw err;
  }
}

/**
 * The dashboard's Debugging page: test errors on the staging demo app. Behind the API token
 * like every route, and 404 unless DEBUG_TOOLS is on.
 */
@Controller('debug')
@UseGuards(new RateLimitGuard(DEBUG_REQUESTS_PER_MINUTE, 60_000))
export class DebugController {
  constructor(private readonly debug: DebugService) {}

  @Get()
  state(): Promise<DebugState> {
    return orNotFound(this.debug.state());
  }

  @Post('errors')
  @HttpCode(200)
  create(@Body({ schema: debugErrorRequestSchema }) body: DebugErrorRequest): Promise<DebugResult> {
    return orNotFound(this.debug.create(body.kind));
  }

  @Post('reset')
  @HttpCode(200)
  reset(): Promise<DebugResult> {
    return orNotFound(this.debug.reset());
  }
}
