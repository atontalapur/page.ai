import { Controller } from '@nestjs/common';
import { RunsService } from './runs.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}
}
