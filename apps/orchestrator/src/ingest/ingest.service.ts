import { Injectable } from '@nestjs/common';

/** Takes PostHog webhooks, upserts the issue by fingerprint and queues triage (#29). */
@Injectable()
export class IngestService {}
