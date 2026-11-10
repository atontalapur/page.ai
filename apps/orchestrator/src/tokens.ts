// Injection tokens for dependencies typed by interfaces, which have no runtime class.
export const DB = Symbol('Db');
export const FIX_JOB_QUEUE = Symbol('FixJobQueue');
export const JOB_QUEUES = Symbol('JobQueues');
export const LOGGER = Symbol('Logger');
export const CONFIG = Symbol('Config');
export const PAGER = Symbol('Pager');
export const CLASSIFIER = Symbol('TriageClassifier');
