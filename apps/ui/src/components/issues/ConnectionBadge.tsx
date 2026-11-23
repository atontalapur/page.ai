import { Badge } from '@page/design-system/components/ui/badge';

import { useIssuesStatus, type IssuesStatus } from '../../context/IssuesContext';

const states: Record<IssuesStatus, { label: string; dot: string; title: string }> = {
  detecting: { label: 'Connecting', dot: 'bg-slate-9', title: 'Looking for the orchestrator' },
  connecting: { label: 'Connecting', dot: 'bg-slate-9', title: 'Connecting to the orchestrator' },
  live: { label: 'Live', dot: 'bg-green-9', title: 'Issues update as they change' },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-amber-9',
    title: 'Lost the orchestrator; retrying. The list reloads once it is back.',
  },
  needs_token: {
    label: 'Token needed',
    dot: 'bg-red-9',
    title: 'Enter your personal token or the API token',
  },
  mock: {
    label: 'Mock data',
    dot: 'bg-blue-9',
    title: 'No orchestrator is connected, so the issues are made up',
  },
};

/** Where the issue feed stands, in the header. Renders nothing outside IssuesProvider. */
export default function ConnectionBadge() {
  const status = useIssuesStatus();
  if (!status) return null;
  const { label, dot, title } = states[status];

  return (
    <Badge variant="outline" title={title} aria-live="polite">
      <span className={`size-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </Badge>
  );
}
