import { Controller, Inject } from '@nestjs/common';
import { TiersService } from './tiers.service.ts';
import type { TiersService as Tiers } from './tiers.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('tiers')
export class TiersController {
  // A class-typed parameter makes oxc emit a metadata branch no test can reach, which fails
  // the strict coverage glob on tier code. The type-only alias emits `Object` instead.
  constructor(@Inject(TiersService) private readonly tiers: Tiers) {}
}
