import { Controller } from '@nestjs/common';
import { NotifyService } from './notify.service.ts';

// No routes yet. They come from @page/contracts with the module's card.
@Controller('notify')
export class NotifyController {
  constructor(private readonly notify: NotifyService) {}
}
