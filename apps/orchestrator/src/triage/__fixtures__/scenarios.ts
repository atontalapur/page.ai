import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenarioMetaSchema, type BugClass } from '@page/contracts';
import { posthogWebhookFixture, webhookFor, type FrameShape } from '@page/contracts/fixtures';
import { reportFrom, titleFrom } from '../../ingest/report.ts';
import type { TriageInput } from '../rules.ts';

// Each scenario's report (scenarios/<id>/meta.json) turned back into the `$exception` webhook
// the demo app's error would send (webhookFor), then into what ingest stores for it: the title
// and the sanitized report. So the triage tests read what staging reads.

const SCENARIOS = join(import.meta.dirname, '../../../../../scenarios');

export type { FrameShape };

export interface ScenarioInput {
  id: string;
  class: BugClass;
  input: TriageInput;
}

/** What ingest stores for each scenario: the issue title and its report. */
export function scenarioInputs(shape: FrameShape): ScenarioInput[] {
  return readdirSync(SCENARIOS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => {
      const meta = scenarioMetaSchema.parse(
        JSON.parse(readFileSync(join(SCENARIOS, id, 'meta.json'), 'utf8')),
      );
      const body = webhookFor(meta.report, shape, posthogWebhookFixture);
      const title = titleFrom(body);
      return { id, class: meta.class, input: { title, report: reportFrom(body, title) } };
    });
}
