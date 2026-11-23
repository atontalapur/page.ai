import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Issue, PosthogWebhook } from '@page/contracts';
import { IssuesService } from '../issues/issues.service.ts';
import type { JobQueues } from '../queue/queues.ts';
import { JOB_QUEUES } from '../tokens.ts';
import { reportFrom, titleFrom } from './report.ts';

const FINGERPRINT_MAX = 512;

@Injectable()
export class IngestService {
  constructor(
    private readonly issues: IssuesService,
    @Inject(JOB_QUEUES) private readonly jobs: JobQueues,
  ) {}

  /**
   * Upserts the exception by PostHog's issue id with its sanitized report and, for a new
   * issue, queues one triage job. Repeats bump `occurrences` and do not queue again.
   */
  async receive(body: PosthogWebhook): Promise<{ issue: Issue; created: boolean }> {
    const fingerprint = body.event.properties.$exception_issue_id;
    if (fingerprint.length > FINGERPRINT_MAX) {
      throw new BadRequestException('fingerprint is too long');
    }
    const title = titleFrom(body);
    const reported = await this.issues.report({ fingerprint, title }, reportFrom(body, title));
    if (reported.created) await this.jobs.sendTriage(reported.issue.id, fingerprint);
    return reported;
  }
}
