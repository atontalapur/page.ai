# PostHog webhook

PostHog sends each `$exception` from the demo app to the orchestrator's `POST /ingest/posthog`,
which opens or bumps an issue and queues triage (#29). This page sets up that destination
(#126).

## What the orchestrator expects

`posthogWebhookSchema` in `@page/contracts` reads the body of PostHog's **HTTP Webhook**
destination template (`template-webhook`) as it ships: `{ "event": "{event}", "person":
"{person}" }`. Keep that body. Ingest needs `event.uuid`, `event.event` (`$exception`),
`event.timestamp` and `event.properties.$exception_issue_id`, which becomes the issue's
fingerprint. It also builds the fix job's report from `$exception_list` (in-app frames only)
and the demo app's `method`, `path`, `route` and `source` properties, or `$current_url` for a
browser error. It never reads `person`, request bodies or headers, and it masks the input a
JSON.parse error message quotes, since that is usually a body.

Use the plain HTTP Webhook destination, not an Error Tracking alert ("issue created" and the
like). Those send a different event, which ingest rejects with a 400.

## 1. Give the orchestrator a public domain

The API needs its token first, so do this only once `ORCHESTRATOR_API_TOKEN` is set on the
orchestrator service and the deploy running includes #100's guard. Then:

```sh
railway domain --service orchestrator
```

Check it: `GET https://<domain>/health` is 200, and `GET https://<domain>/issues` without a token
is 401.

## 2. The destination

In PostHog: Data pipelines → Destinations → New destination → **HTTP Webhook**.

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| Webhook URL    | `https://<domain>/ingest/posthog`                        |
| Method         | `POST`                                                   |
| JSON Body      | the template's default, unchanged                        |
| Headers        | the template's default, `Content-Type: application/json` |
| Secret headers | `Authorization` = `Bearer <POSTHOG_WEBHOOK_SECRET>`      |
| Filters        | event `$exception`; no property filters                  |

Put the secret in **Secret headers**, not Headers: PostHog encrypts it and keeps it out of the
logs. Its value is the orchestrator service's `POSTHOG_WEBHOOK_SECRET`, also in `.env` after
`pnpm env:pull`.

## 3. Check it

1. Throw an error in the staging demo app.
2. The destination's Logs tab shows a 200. A 401 means the secret differs from the
   orchestrator's; a 400 means the body or the event filter changed.
3. `railway logs --service orchestrator` shows triage and notify for the new issue, and
   on-call gets the page (docs/twilio.md).

Repeats of the same error bump `occurrences` on the open issue and don't page again.
