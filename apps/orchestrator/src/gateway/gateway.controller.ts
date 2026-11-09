import { Controller } from '@nestjs/common';
import { GatewayService } from './gateway.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}
}
