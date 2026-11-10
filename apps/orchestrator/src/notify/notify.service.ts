import { Inject, Injectable } from '@nestjs/common';
import type { JobPayload } from '@page/contracts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { NotifyAttempt } from '../queue/workers.ts';
import { CONFIG, LOGGER, PAGER } from '../tokens.ts';
import type { Pager } from './pager.ts';

@Injectable()
export class NotifyService {
  constructor(
    @Inject(PAGER) private readonly pager: Pager,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Places the call, then sends the same message by SMS. A call that still fails on its
   * last try sends SMS only, so the page is not lost. No numbers configured completes the
   * job without paging.
   */
  async deliver(job: JobPayload<'notify'>, attempt: NotifyAttempt): Promise<void> {
    const numbers = this.config.notifyTo;
    if (numbers.length === 0) {
      this.logger.warn({ issueId: job.issueId }, 'notify skipped, no numbers configured');
      return;
    }
    if (job.channel === 'sms') {
      for (const to of numbers) await this.pager.sms(to, job.message);
      return;
    }
    try {
      for (const to of numbers) await this.pager.call(to, job.message);
    } catch (err) {
      if (attempt.retryCount < attempt.retryLimit) throw err;
      this.logger.warn({ err, issueId: job.issueId }, 'call failed, sending SMS');
      for (const to of numbers) await this.pager.sms(to, job.message);
      return;
    }
    for (const to of numbers) await this.pager.sms(to, job.message);
  }
}
