import { Inject, Injectable } from '@nestjs/common';
import type { JobPayload } from '@page/contracts';
import type { Logger } from '../logger.ts';
import type { NotifyAttempt } from '../queue/workers.ts';
import { LOGGER, PAGER } from '../tokens.ts';
import { maskNumber } from './mask.ts';
import type { Pager } from './pager.ts';

@Injectable()
export class NotifyService {
  constructor(
    @Inject(PAGER) private readonly pager: Pager,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Pages one phone: a call, then the same message by SMS. A call that fails or that nobody
   * answers (busy, no answer) throws so pg-boss retries this job, and one that still fails on
   * its last try sends the SMS instead, so the page is not lost.
   *
   * Triage queues one job per phone, so a retry never rings another phone. Once the call is
   * placed, a failed follow-up text is logged and the job completes: throwing would retry
   * the job and ring this phone again. A Twilio trial account rejects every custom SMS body,
   * so without TWILIO_TRIAL that case is the norm on trial (docs/twilio.md).
   */
  async deliver(job: JobPayload<'notify'>, attempt: NotifyAttempt): Promise<void> {
    const context = { issueId: job.issueId, to: maskNumber(job.to) };
    if (job.channel === 'sms') {
      await this.pager.sms(job.to, job.message);
      return;
    }
    try {
      await this.pager.call(job.to, job.message);
    } catch (err) {
      if (attempt.retryCount < attempt.retryLimit) {
        this.logger.warn({ err, ...context, retryCount: attempt.retryCount }, 'call failed');
        throw err;
      }
      this.logger.warn({ err, ...context }, 'call failed on its last try, sending SMS');
      await this.pager.sms(job.to, job.message);
      return;
    }
    try {
      await this.pager.sms(job.to, job.message);
    } catch (err) {
      this.logger.warn({ err, ...context }, 'follow-up SMS failed after the call');
    }
  }
}
