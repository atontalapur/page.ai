import { Inject, Injectable } from '@nestjs/common';
import type { JobPayload } from '@page/contracts';
import type { Config } from '../config.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { issueLogger, type Logger } from '../logger.ts';
import { pageMessage } from '../notify/message.ts';
import type { JobQueues } from '../queue/queues.ts';
import { CLASSIFIER, CONFIG, JOB_QUEUES, LOGGER } from '../tokens.ts';
import type { TriageClassifier } from './classify.ts';

@Injectable()
export class TriageService {
  constructor(
    private readonly issues: IssuesService,
    @Inject(JOB_QUEUES) private readonly jobs: JobQueues,
    @Inject(CLASSIFIER) private readonly classifier: TriageClassifier,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Classifies a new issue, pages on-call, and moves it to `triaged`. */
  async handle(job: JobPayload<'triage'>): Promise<void> {
    const issue = await this.issues.get(job.issueId);
    if (issue.status !== 'new') return;

    const verdict = await this.classifier.classify(issue.title);
    const message = pageMessage({
      severity: verdict.severity,
      class: verdict.class,
      title: issue.title,
      issueId: issue.id,
      dashboardUrl: this.config.dashboardUrl,
    });
    // One job per phone, so a retry pages only the phone that missed it.
    const numbers = this.config.notifyTo;
    if (numbers.length === 0) {
      issueLogger(this.logger, { issueId: issue.id }).warn('no numbers configured, nobody paged');
    }
    for (const to of numbers) {
      await this.jobs.sendNotify(
        { v: 2, issueId: issue.id, channel: 'call', to, message },
        issue.fingerprint,
      );
    }
    await this.issues.apply(issue.id, {
      type: 'triage',
      class: verdict.class,
      severity: verdict.severity,
    });
    issueLogger(this.logger, { issueId: issue.id }).info(
      { class: verdict.class, severity: verdict.severity },
      'issue triaged',
    );
  }
}
