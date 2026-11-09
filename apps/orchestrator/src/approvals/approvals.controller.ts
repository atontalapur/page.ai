import { Controller, Inject } from '@nestjs/common';
import { ApprovalsService } from './approvals.service.ts';
import type { ApprovalsService as Approvals } from './approvals.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('approvals')
export class ApprovalsController {
  // A class-typed parameter makes oxc emit a metadata branch no test can reach, which fails
  // the strict coverage glob on approval code. The type-only alias emits `Object` instead.
  constructor(@Inject(ApprovalsService) private readonly approvals: Approvals) {}
}
