import type { Decider, Embedder, ModelClient } from '@page/model-client';
import type { GitHubApi } from './github/github-api.ts';
import type { Config } from './config.ts';
import type { Db } from './db/database.ts';
import type { Logger } from './logger.ts';
import type { Pager } from './notify/pager.ts';
import type { FixJobQueue } from './queue/fix-jobs.ts';
import type { JobQueues } from './queue/queues.ts';
import type { TriageClassifier } from './triage/classify.ts';

/** What the app needs from outside. main.ts builds the real ones, tests build fakes. */
export interface AppDeps {
  db: Db;
  fixJobs: FixJobQueue;
  jobs: JobQueues;
  logger: Logger;
  config: Config;
  pager: Pager;
  classifier: TriageClassifier;
  /** jev, for triage, the starting tier and escalation. Null falls back to the rules. */
  decider: Decider | null;
  /** Embeds knowledge-graph nodes and queries. */
  embedder: Embedder;
  /** The demo repo's PRs. Null when GITHUB_* is unset: the dashboard alone decides. */
  github: GitHubApi | null;
  /** Answers reviewers' questions on the bot's PRs. Null leaves them unanswered. */
  answerer: ModelClient | null;
}
