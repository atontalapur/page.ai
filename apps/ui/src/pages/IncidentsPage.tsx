import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DangerTriangleIcon, MagnifierIcon } from '@solar-icons/react/bold-duotone';
import { ISSUE_STATUSES, SEVERITIES } from '@page/contracts';

import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import { Input } from '@page/design-system/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@page/design-system/components/ui/table';

import { SeverityBadge, StatusBadge } from '../components/issues/IssueBadges';
import TokenPrompt from '../components/issues/TokenPrompt';
import { useIssues } from '../context/IssuesContext';
import {
  classLabel,
  isOpen,
  severityLabels,
  shortId,
  statusLabels,
  tierLabel,
  UNTRIAGED,
} from '../lib/issueLabels';

const ALL = 'All';

export default function IncidentsPage() {
  const { issues, loaded, status: feed } = useIssues();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(ALL);
  const [severity, setSeverity] = useState(ALL);

  const filteredIssues = useMemo(() => {
    const query = search.toLowerCase();
    return issues.filter((issue) => {
      const matchesSearch =
        issue.title.toLowerCase().includes(query) ||
        issue.id.toLowerCase().includes(query) ||
        issue.fingerprint.toLowerCase().includes(query);

      const matchesStatus = status === ALL || issue.status === status;

      const matchesSeverity =
        severity === ALL ||
        issue.severity === severity ||
        (severity === UNTRIAGED && issue.severity === null);

      return matchesSearch && matchesStatus && matchesSeverity;
    });
  }, [issues, search, status, severity]);

  const metrics = [
    { label: 'Total Incidents', value: issues.length },
    { label: 'Open Incidents', value: issues.filter(isOpen).length },
    {
      label: 'Critical Incidents',
      value: issues.filter((issue) => issue.severity === 'critical').length,
    },
    {
      label: 'Awaiting Approval',
      value: issues.filter((issue) => issue.status === 'awaiting_approval').length,
    },
  ];

  const emptyMessage = !loaded
    ? feed === 'needs_token'
      ? 'Connect with the API token to load incidents.'
      : 'Loading incidents...'
    : issues.length === 0
      ? 'No incidents yet. They appear here as errors arrive.'
      : 'No incidents match your filters.';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Incidents</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Errors reported by the app, updated live as triage and agents work on them.
        </p>
      </div>

      <TokenPrompt />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Like a Notion database view: a title row, the filters, then the table on the page. */}
      <section aria-labelledby="all-incidents" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="all-incidents" className="flex items-center gap-2 text-sm font-semibold">
            <DangerTriangleIcon className="size-4 text-muted-foreground" />
            All incidents
            <span
              aria-label={`${filteredIssues.length} incidents`}
              className="font-normal text-muted-foreground tabular-nums"
            >
              {filteredIssues.length}
            </span>
          </h3>

          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">
            <div className="relative min-w-0 flex-1">
              <MagnifierIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search incidents..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9 md:w-64"
              />
            </div>

            <select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground"
            >
              <option value={ALL}>All Statuses</option>
              {ISSUE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {statusLabels[value]}
                </option>
              ))}
            </select>

            <select
              aria-label="Filter by severity"
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2.5 text-sm text-muted-foreground"
            >
              <option value={ALL}>All Severities</option>
              {SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {severityLabels[value]}
                </option>
              ))}
              <option value={UNTRIAGED}>{UNTRIAGED}</option>
            </select>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Incident</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Occurrences</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {filteredIssues.map((issue) => (
              <TableRow key={issue.id} data-issue-id={issue.id}>
                <TableCell>
                  <Link to={`/incidents/${issue.id}`} className="block max-w-64 hover:underline">
                    <span className="block truncate font-medium" title={issue.title}>
                      {issue.title}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {shortId(issue.id)}
                    </span>
                  </Link>
                </TableCell>

                <TableCell>
                  <StatusBadge status={issue.status} />
                </TableCell>

                <TableCell className="whitespace-nowrap">{classLabel(issue.class)}</TableCell>

                <TableCell>
                  <SeverityBadge severity={issue.severity} />
                </TableCell>

                <TableCell>{issue.occurrences}</TableCell>

                <TableCell className="whitespace-nowrap">{tierLabel(issue.currentTier)}</TableCell>

                <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                  {new Date(issue.updatedAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}

            {filteredIssues.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
