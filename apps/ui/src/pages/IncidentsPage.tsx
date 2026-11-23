import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Search } from 'lucide-react';

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@page/design-system/components/ui/card';
import { Badge } from '@page/design-system/components/ui/badge';
import { Input } from '@page/design-system/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@page/design-system/components/ui/table';

import {
  mockIncidents,
  type IncidentSeverity,
  type IncidentStatus,
} from '../data/mockIncidents';

const severityStyles: Record<IncidentSeverity, string> = {
  Critical: 'border-red-200 bg-red-100 text-red-700',
  High: 'border-orange-200 bg-orange-100 text-orange-700',
  Medium: 'border-yellow-200 bg-yellow-100 text-yellow-700',
  Low: 'border-blue-200 bg-blue-100 text-blue-700',
};

const statusStyles: Record<IncidentStatus, string> = {
  Open: 'border-blue-200 bg-blue-100 text-blue-700',
  Investigating: 'border-purple-200 bg-purple-100 text-purple-700',
  'Awaiting Approval': 'border-amber-200 bg-amber-100 text-amber-700',
  Resolved: 'border-green-200 bg-green-100 text-green-700',
};

export default function IncidentsPage() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('All');
  const [severity, setSeverity] = useState('All');

  const filteredIncidents = useMemo(() => {
    return mockIncidents.filter((incident) => {
      const matchesSearch =
        incident.title.toLowerCase().includes(search.toLowerCase()) ||
        incident.id.toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        status === 'All' || incident.status === status;

      const matchesSeverity =
        severity === 'All' || incident.severity === severity;

      return matchesSearch && matchesStatus && matchesSeverity;
    });
  }, [search, status, severity]);

  const total = mockIncidents.length;
  const active = mockIncidents.filter(
    (incident) => incident.status !== 'Resolved'
  ).length;
  const critical = mockIncidents.filter(
    (incident) => incident.severity === 'Critical'
  ).length;
  const awaitingApproval = mockIncidents.filter(
    (incident) => incident.status === 'Awaiting Approval'
  ).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Incidents</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Monitor detected errors and track AI investigations.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Total Incidents', value: total },
          { label: 'Active Incidents', value: active },
          { label: 'Critical Incidents', value: critical },
          { label: 'Awaiting Approval', value: awaitingApproval },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {metric.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>All Incidents</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {filteredIncidents.length} incidents found
              </p>
            </div>
            <AlertTriangle className="size-5 text-muted-foreground" />
          </div>

          <div className="flex flex-col gap-3 md:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search incidents..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
              />
            </div>

            <select
              aria-label="Filter by status"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="All">All Statuses</option>
              <option value="Open">Open</option>
              <option value="Investigating">Investigating</option>
              <option value="Awaiting Approval">Awaiting Approval</option>
              <option value="Resolved">Resolved</option>
            </select>

            <select
              aria-label="Filter by severity"
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="All">All Severities</option>
              <option value="Critical">Critical</option>
              <option value="High">High</option>
              <option value="Medium">Medium</option>
              <option value="Low">Low</option>
            </select>
          </div>
        </CardHeader>

        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Incident</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Occurrences</TableHead>
                  <TableHead>Assigned Agent</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>

              <TableBody>
                {filteredIncidents.map((incident) => (
                  <TableRow key={incident.id}>
                    <TableCell>
                      <Link
                        to={`/incidents/${incident.id}`}
                        className="block max-w-64 hover:underline"
                      >
                        <span className="block font-medium">
                          {incident.title}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {incident.id}
                        </span>
                      </Link>
                    </TableCell>

                    <TableCell>
                      <Badge
                        variant="outline"
                        className={severityStyles[incident.severity]}
                      >
                        {incident.severity}
                      </Badge>
                    </TableCell>

                    <TableCell>
                      <Badge
                        variant="outline"
                        className={statusStyles[incident.status]}
                      >
                        {incident.status}
                      </Badge>
                    </TableCell>

                    <TableCell>{incident.occurrences}</TableCell>

                    <TableCell>
                      {incident.assignedAgent ?? 'Unassigned'}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {new Date(incident.updatedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}

                {filteredIncidents.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="py-10 text-center text-muted-foreground"
                    >
                      No incidents match your filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
