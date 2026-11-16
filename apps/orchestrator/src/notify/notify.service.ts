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
   * Calls every number, then sends every number the same message by SMS: a follow-up for
   * the phones that rang, the page itself for the ones that didn't. No numbers configured
   * completes the job without paging.
   *
   * The job retries only when no call went through, so a retry never rings a phone twice.
   * Once any phone rang, failed calls and texts are logged and the job completes. A Twilio
   * trial account rejects every custom SMS body, so failed texts are the norm on trial
   * (docs/twilio.md). The job fails only when nothing reached anyone on its last try.
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
    const call = (to: string) => this.pager.call(to, job.message);
    const callErrors = await this.eachNumber(numbers, call, job.issueId, 'call failed');
    const [callError] = callErrors;
    const nobodyRang = callErrors.length === numbers.length;
    if (nobodyRang && callError && attempt.retryCount < attempt.retryLimit) throw callError;
    const text = (to: string) => this.pager.sms(to, job.message);
    const textErrors = await this.eachNumber(numbers, text, job.issueId, 'SMS failed');
    const [textError] = textErrors;
    if (nobodyRang && textError && textErrors.length === numbers.length) throw textError;
  }

  /** Runs send for every number, logs each failure, and returns the errors. */
  private async eachNumber(
    numbers: string[],
    send: (to: string) => Promise<void>,
    issueId: string,
    failure: string,
  ): Promise<Error[]> {
    const errors: Error[] = [];
    for (const to of numbers) {
      try {
        await send(to);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
        this.logger.warn({ err, issueId }, failure);
      }
    }
    return errors;
  }
}
