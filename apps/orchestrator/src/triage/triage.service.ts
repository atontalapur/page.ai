import { Inject, Injectable } from '@nestjs/common';
import type { Issue, JobPayload } from '@page/contracts';
import type { Config } from '../config.ts';
import { IssuesService } from '../issues/issues.service.ts';
import { issueLogger, type Logger } from '../logger.ts';
import { pageMessage } from '../notify/message.ts';
import type { JobQueues } from '../queue/queues.ts';
import { CLASSIFIER, CONFIG, JOB_QUEUES, LOGGER } from '../tokens.ts';
import type { TriageClassifier } from './classify.ts';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class TriageService {
  constructor(
    private readonly issues: IssuesService,
    @Inject(JOB_QUEUES) private readonly jobs: JobQueues,
    @Inject(CLASSIFIER) private readonly classifier: TriageClassifier,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Classifies a new issue, pages on-call, and moves it to `triaged`. With AUTO_START_FIX,
   * it then sends `start_fix`, which queues the Tier 1 fix job. A retry after a failed
   * start finds the issue `triaged` and only starts the fix.
   *
   * The report comes from a PostHog event, which anyone holding the public project key can
   * forge, and it becomes the agent's task. So once AUTO_START_FIX_MAX_PER_HOUR fixes have
   * started in the last hour, the issue stays `triaged` for an operator to start. The triage
   * worker takes one job at a time, so one orchestrator holds the cap exactly; each extra
   * instance could start one more past it.
   */
  async handle(job: JobPayload<'triage'>): Promise<void> {
    let issue = await this.issues.get(job.issueId);
    if (issue.status === 'new') issue = await this.classify(issue);
    if (issue.status === 'triaged' && this.config.autoStartFix) {
      const max = this.config.autoStartFixMaxPerHour;
      const started = await this.issues.fixesStartedWithin(HOUR_MS);
      if (started >= max) {
        issueLogger(this.logger, { issueId: issue.id }).warn(
          { started, max },
          'auto-start cap reached; the issue waits for a start_fix event',
        );
        return;
      }
      const fixing = await this.issues.apply(issue.id, { type: 'start_fix' });
      issueLogger(this.logger, { issueId: issue.id, tier: fixing.currentTier }).info('fix started');
    }
  }

  private async classify(issue: Issue): Promise<Issue> {
    const report = await this.issues.storedReport(issue.id);
    const verdict = await this.classifier.classify({ title: issue.title, report });
    const log = issueLogger(this.logger, { issueId: issue.id });
    if (verdict.fallback !== undefined) {
      log.warn({ fallback: verdict.fallback }, 'triage model failed, rules classified the issue');
    }
    const message = pageMessage({
      severity: verdict.severity,
      class: verdict.class,
      title: issue.title,
      issueId: issue.id,
      dashboardUrl: this.config.dashboardUrl,
    });
    // One job per phone, so a retry pages only the phone that missed it.
    const numbers = this.config.notifyTo;
    if (numbers.length === 0) log.warn('no numbers configured, nobody paged');
    for (const to of numbers) {
      await this.jobs.sendNotify(
        { v: 2, issueId: issue.id, channel: 'call', to, message },
        issue.fingerprint,
      );
    }
    const triaged = await this.issues.apply(issue.id, {
      type: 'triage',
      class: verdict.class,
      severity: verdict.severity,
    });
    // Railway's log parser drops a `severity` field (staging's `issue triaged` lines show only
    // the class), so the verdict's severity goes under another name.
    log.info(
      { class: verdict.class, issueSeverity: verdict.severity, by: verdict.by },
      'issue triaged',
    );
    return triaged;
  }
}
