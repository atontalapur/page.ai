import type { BugClass, Severity } from '@page/contracts';

/** The sentence spoken on the call and sent in the SMS, ending in the issue's UI page. */
export function pageMessage(input: {
  severity: Severity;
  class: BugClass;
  title: string;
  issueId: string;
  dashboardUrl: string;
}): string {
  const base = input.dashboardUrl.replace(/\/$/, '');
  return `${input.severity} ${input.class}: ${input.title} ${base}/incidents/${input.issueId}`;
}
