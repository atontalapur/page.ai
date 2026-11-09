import { Controller } from '@nestjs/common';
import { TriageService } from './triage.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('triage')
export class TriageController {
  constructor(private readonly triage: TriageService) {}
}
