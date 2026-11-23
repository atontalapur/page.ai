import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AltArrowLeftIcon, BotIcon } from '@solar-icons/react/bold-duotone';

import { Card, CardContent, CardHeader, CardTitle } from '@page/design-system/components/ui/card';
import { buttonVariants } from '@page/design-system/components/ui/button';

import { SeverityBadge, StatusBadge } from '../components/issues/IssueBadges';
import ActivityPanel from '../components/issues/ActivityPanel';
import ApprovalRequests from '../components/issues/ApprovalRequests';
import DecisionsPanel from '../components/issues/DecisionsPanel';
import ReviewActions, { awaitsReview } from '../components/issues/ReviewActions';
import RunsPanel from '../components/issues/RunsPanel';
import TokenPrompt from '../components/issues/TokenPrompt';
import { useIssues } from '../context/IssuesContext';
import { classLabel, shortId, tierLabel } from '../lib/issueLabels';

function BackLink() {
  return (
    <Link
      to="/incidents"
      className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
    >
      <AltArrowLeftIcon className="size-4" />
      Back to Incidents
    </Link>
  );
}

/**
 * One issue, from the live store. An issue past the 200 the list holds (an old link from a
 * page, say) is fetched on its own once, and stays current from then on like the rest.
 */
export default function IncidentDetailsPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { getIssue, fetchIssue, loaded, status } = useIssues();
  const issue = getIssue(id);
  const [lookedUp, setLookedUp] = useState<string | undefined>();

  useEffect(() => {
    if (issue || !loaded || lookedUp === id) return;
    let cancelled = false;
    void fetchIssue(id).finally(() => {
      if (!cancelled) setLookedUp(id);
    });
    return () => {
      cancelled = true;
    };
  }, [id, issue, loaded, lookedUp, fetchIssue]);

  if (!issue) {
    const searching = status !== 'needs_token' && (!loaded || lookedUp !== id);
    return (
      <div className="space-y-4">
        <TokenPrompt />
        {searching ? (
          <p className="text-muted-foreground">Loading incident...</p>
        ) : (
          <>
            <h2 className="text-2xl font-bold">Incident not found</h2>
            <p className="text-muted-foreground">The requested incident does not exist.</p>
            <Link to="/incidents" className={buttonVariants({ variant: 'outline' })}>
              <AltArrowLeftIcon className="size-4" />
              Back to Incidents
            </Link>
          </>
        )}
      </div>
    );
  }

  const metrics = [
    { label: 'Occurrences', value: String(issue.occurrences) },
    { label: 'Class', value: classLabel(issue.class) },
    { label: 'Current Tier', value: tierLabel(issue.currentTier) },
    { label: 'Last Updated', value: new Date(issue.updatedAt).toLocaleString() },
  ];

  const details = [
    { label: 'Issue ID', value: issue.id },
    { label: 'Fingerprint', value: issue.fingerprint },
    { label: 'First Seen', value: new Date(issue.createdAt).toLocaleString() },
  ];

  return (
    <div className="space-y-6">
      <BackLink />

      {/* Shown when the token is refused, or the person switches tokens from the approval bar. */}
      <TokenPrompt />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <p className="font-mono text-sm text-muted-foreground">{shortId(issue.id)}</p>
          <h2 className="break-words text-2xl font-bold tracking-tight">{issue.title}</h2>
        </div>

        <div className="flex flex-wrap gap-2">
          <SeverityBadge severity={issue.severity} />
          <StatusBadge status={issue.status} />
        </div>
      </div>

      <ApprovalRequests issue={issue} />
      {awaitsReview(issue) && <ReviewActions issue={issue} />}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section aria-labelledby="runs-heading" className="min-w-0 space-y-3">
          <h3 id="runs-heading" className="flex items-center gap-2 text-base font-semibold">
            <BotIcon className="size-5" />
            Agent runs
          </h3>
          <RunsPanel issue={issue} />
        </section>

        <div className="space-y-6 lg:sticky lg:top-4">
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <ActivityPanel issue={issue} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Decisions</CardTitle>
            </CardHeader>
            <CardContent>
              <DecisionsPanel issue={issue} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                {details.map((detail) => (
                  <div key={detail.label}>
                    <dt className="text-muted-foreground">{detail.label}</dt>
                    <dd className="break-all font-mono">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
