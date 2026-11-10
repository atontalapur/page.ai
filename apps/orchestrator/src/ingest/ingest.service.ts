import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Issue, PosthogWebhook } from '@page/contracts';
import { IssuesService } from '../issues/issues.service.ts';
import type { JobQueues } from '../queue/queues.ts';
import { JOB_QUEUES } from '../tokens.ts';

const TITLE_MAX = 500;
const FINGERPRINT_MAX = 512;

function titleFrom(body: PosthogWebhook): string {
  const props = body.event.properties;
  const parts = [props.$exception_types?.[0], props.$exception_values?.[0]].filter(
    (part): part is string => !!part && part.trim().length > 0,
  );
  const title = parts.join(': ').trim();
  return (title || 'Exception').slice(0, TITLE_MAX);
}

@Injectable()
export class IngestService {
  constructor(
    private readonly issues: IssuesService,
    @Inject(JOB_QUEUES) private readonly jobs: JobQueues,
  ) {}

  /**
   * Upserts the exception by PostHog's issue id and, for a new issue, queues one triage job.
   * Repeats bump `occurrences` and do not queue again.
   */
  async receive(body: PosthogWebhook): Promise<{ issue: Issue; created: boolean }> {
    const fingerprint = body.event.properties.$exception_issue_id;
    if (fingerprint.length > FINGERPRINT_MAX) {
      throw new BadRequestException('fingerprint is too long');
    }
    const reported = await this.issues.report({ fingerprint, title: titleFrom(body) });
    if (reported.created) await this.jobs.sendTriage(reported.issue.id, fingerprint);
    return reported;
  }
}
