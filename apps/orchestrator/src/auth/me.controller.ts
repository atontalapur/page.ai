import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import type { Session } from '@page/contracts';
import { ApiTokens, type Caller } from './api-tokens.ts';
import { CallerOf } from './caller.ts';

@Controller('me')
export class MeController {
  constructor(private readonly tokens: ApiTokens) {}

  /**
   * Who the token names (sessionSchema): a person, whom the UI shows as signed in, or the
   * shared token, with whether it may decide Tier 3 approvals under a name the tab gives.
   */
  @Get()
  me(@CallerOf() caller: Caller | undefined): Session {
    // The guard sets the caller on every route it lets through.
    if (caller === undefined) throw new UnauthorizedException();
    if (caller.kind === 'person') return { token: 'personal', name: caller.name };
    return { token: 'shared', canDecide: !this.tokens.personal };
  }
}
