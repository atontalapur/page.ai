import type { BugClass, Severity } from '@page/contracts';

/** The sentence spoken on the call and sent in the SMS. */
export function pageMessage(input: {
  severity: Severity;
  class: BugClass;
  title: string;
  issueId: string;
  dashboardUrl: string;
}): string {
  const base = input.dashboardUrl.replace(/\/$/, '');
  return `${input.severity} ${input.class}: ${input.title} ${base}/issues/${input.issueId}`;
}
