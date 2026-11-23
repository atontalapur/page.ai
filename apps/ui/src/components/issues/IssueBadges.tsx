import type { IssueStatus, Severity } from '@page/contracts';
import { Badge } from '@page/design-system/components/ui/badge';

import { severityLabel, statusLabels } from '../../lib/issueLabels';
import { issueStatusStyles, severityStyles, untriagedStyle } from '../../lib/statusStyles';

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <Badge variant="outline" className={issueStatusStyles[status]}>
      {statusLabels[status]}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  return (
    <Badge variant="outline" className={severity ? severityStyles[severity] : untriagedStyle}>
      {severityLabel(severity)}
    </Badge>
  );
}
