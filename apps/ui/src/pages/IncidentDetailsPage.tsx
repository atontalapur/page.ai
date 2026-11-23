import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, AlertTriangle, Bot, Clock, Activity, FileCode } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import { Badge } from '@page/design-system/components/ui/badge';
import { Button } from '@page/design-system/components/ui/button';

import { getIncidentById, type IncidentSeverity, type IncidentStatus } from '../data/mockIncidents';

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

export default function IncidentDetailsPage() {
  const { id } = useParams<{ id: string }>();

  const incident = id ? getIncidentById(id) : undefined;

  if (!incident) {
    return (
      <div className="space-y-4">
        <h2 className="text-2xl font-bold">Incident not found</h2>
        <p className="text-muted-foreground">The requested incident does not exist.</p>
        <Button variant="outline">
          <Link to="/incidents">
            <ArrowLeft className="mr-2 size-4" />
            Back to Incidents
          </Link>
        </Button>
      </div>
    );
  }

  const timeline = [
    {
      title: 'Incident detected',
      description: `Error detected through ${incident.source}`,
      time: incident.createdAt,
      icon: AlertTriangle,
    },
    ...(incident.assignedAgent
      ? [
          {
            title: 'Agent assigned',
            description: `${incident.assignedAgent} assigned to investigate`,
            time: incident.updatedAt,
            icon: Bot,
          },
        ]
      : []),
    {
      title: 'Current status',
      description: incident.status,
      time: incident.updatedAt,
      icon: Activity,
    },
  ];

  return (
    <div className="space-y-6">
      <Link
        to="/incidents"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to Incidents
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{incident.id}</p>
          <h2 className="text-2xl font-bold tracking-tight">{incident.title}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{incident.description}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={severityStyles[incident.severity]}>
            {incident.severity}
          </Badge>
          <Badge variant="outline" className={statusStyles[incident.status]}>
            {incident.status}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Occurrences', value: incident.occurrences },
          { label: 'Source', value: incident.source },
          { label: 'Assigned Agent', value: incident.assignedAgent ?? 'None' },
          {
            label: 'Last Updated',
            value: new Date(incident.updatedAt).toLocaleString(),
          },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{metric.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="break-words text-lg font-semibold">{metric.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileCode className="size-5" />
                Error Stack Trace
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-4 text-xs leading-6 text-slate-100">
                <code>{incident.stackTrace}</code>
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Investigation Timeline</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-6">
                {timeline.map((event, index) => (
                  <div key={index} className="flex gap-4 border-l-2 border-border pl-4">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                      <event.icon className="size-4" />
                    </div>

                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{event.title}</p>
                      <p className="text-sm text-muted-foreground">{event.description}</p>
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3" />
                        {new Date(event.time).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Agent Investigation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {incident.assignedAgent ? (
                <>
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                      <Bot className="size-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium">{incident.assignedAgent}</p>
                      <p className="text-xs text-muted-foreground">Assigned Agent</p>
                    </div>
                  </div>

                  <Button className="w-full">
                    <Link to={`/agents/${incident.assignedAgent}`}>View Agent Workspace</Link>
                  </Button>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No agent has been assigned to this incident.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
