import { Controller } from '@nestjs/common';
import { IngestService } from './ingest.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}
}
