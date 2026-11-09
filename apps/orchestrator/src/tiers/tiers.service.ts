import { Injectable } from '@nestjs/common';

/** Decides escalation after a run: up a tier, or to failed past Tier 3. */
@Injectable()
export class TiersService {}
