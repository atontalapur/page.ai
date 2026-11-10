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
}
