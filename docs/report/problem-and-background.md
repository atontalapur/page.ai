# Problem and background

This section covers the problem PageAgents works on, what the system does from an error to a
fix, the work it builds on, and why it grants access in tiers and runs the agent's commands
in a sandbox.

## The on-call problem

On-call engineers get paged for routine production errors, such as a missing null check or a
bad config value. Each page still costs a context switch, time in the logs and a patch.
PostHog captures the exception and its context, but it stops at the alert. Coding agents can
now write patches that pass tests. PageAgents joins the two: it turns the error report into a
coding agent's task, and limits the agent to what each tier can safely touch
([README](../../README.md#problem-and-background)).

## What PageAgents does

The demo app (`apps/demo-app`), a Next.js and Postgres shop, plays production. When it throws,
it reports the error to PostHog Error Tracking, and a PostHog webhook posts the `$exception`
event to the orchestrator. The orchestrator groups repeats by fingerprint and stores a report
with the request line, the exception and its in-app frames. It drops bodies, headers, cookies,
query values and email addresses, since a Tier 2 run puts the report in a public PR. Triage
sets the bug's class and severity with a cheap OpenRouter model, and rules over the same report
take over when the model times out or replies with junk. The orchestrator then calls and texts
on-call through Twilio with a link to the dashboard. With automatic starts on, triage also
queues a Tier 1 fix job, at most 5 an hour by default. A node daemon claims the job, starts a
sandbox with no network, and runs the agent on the report. Each tier gets 40 model calls, $0.50
and 14 minutes ([`threshold.ts`](../../packages/agent/src/threshold.ts)). A run that hits a
limit before it submits moves the issue up a tier, and so does a submitted patch whose
confidence score is under the tier's threshold. Past Tier 3 the issue fails and stays with a
person. A patch that scores well enough waits for a person to approve it. A Tier 3 run that
fixed the live app without changing code resolves the issue, since the fix is live already
([README](../../README.md#how-it-works)).

Every command the agent runs goes through `execute()` in `@page/toolkit`, which checks it
against the tier's rules and writes an audit row before it runs. At Tier 3, a call that changes
the live app also waits up to 3 minutes for a person to approve it on the incident page.

## Prior work

The agent is a TypeScript port of [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)
in `packages/agent` (#28). The loop is upstream's: ask the model, run the one action its reply
gives, show it the result, and repeat until it submits or hits a limit
([`agent.ts`](../../packages/agent/src/agent.ts)). The prompts are adapted from upstream's
`mini_textbased.yaml` at commit `04d809c`, and keep its workflow and its rule of one action per
reply ([`prompts.ts`](../../packages/agent/src/prompts.ts)). The command examples are ours. Tier
1 has no `sed` or `echo`, so edits go through an edit tool (`page_edit`, a search and replace
block), and submitting is an action of its own (`page_submit`) rather than a magic `echo`.
Upstream has no step limit by default and a $3 cost limit. The port takes its step, cost and
time limits from the escalation threshold of the tier it runs at.

The rest is wired to existing services. PostHog Error Tracking captures the demo app's errors,
and its HTTP Webhook destination sends them on ([docs/posthog.md](../posthog.md)). Twilio places
the calls and texts ([docs/twilio.md](../twilio.md)). Queues are pg-boss tables in the same
Postgres as the issues, so a fix job commits in the same transaction as the status change that
causes it ([ADR 0003](../adr/0003-pg-boss-over-redis.md)).

## Why tiers

Each tier adds what the agent can reach:

| Tier | What the agent can do                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | Read, search, edit and test the code in the sandbox through an allowlist of shell commands                                    |
| 2    | Tier 1, plus push a `pageagents/<runId>` branch and open a PR on the demo repo, `atontalapur/page-demo`                       |
| 3    | Tier 2, plus read and change the live demo app's runtime config, restart it (at most 3 times) and roll back its deploy (once) |

The shell commands are the same at every tier. Tiers differ in the host tools, which run in the
daemon rather than the sandbox, each allowed from a minimum tier
([`policy.ts`](../../packages/toolkit/src/policy/policy.ts)).

A Tier 1 run changes only the sandbox's copy of the code. A Tier 2 run writes outside it, to a
public repo, though only to its own branch and a PR that a person reviews and merges. The agent
has no merge tool. Rulesets on that repo, which bind the daemon's token too, send every change
to `main` through a PR and stop anyone writing a branch outside `pageagents/`
([docs/demo-repo.md](../demo-repo.md)). A Tier 3 run changes the app users are on. A restart
drops requests in flight, a settings change loads on the next restart of any kind, and a
rollback replaces the live build ([`approval.ts`](../../packages/toolkit/src/exec/approval.ts)).

So an issue starts at Tier 1 and climbs only when a run there runs out of budget or submits a
patch that scores too low. The evaluation measures this ladder against a run that stays at Tier
1 and one that has every Tier 3 capability from the first step. The question is how close the
ladder gets to the Tier 3 fix rate while granting a higher tier only to runs that need it
([evaluation-method.md](evaluation-method.md#configurations)).

## Why a sandbox

The agent runs shell commands a model chose, against the demo app's code. Those commands can be
wrong or hostile: a fix attempt might `curl` a script, read environment variables or loop
forever. The agent loop itself needs the network to call the model, so it holds API keys
([ADR 0001](../adr/0001-sandbox-network-policy.md)). The design splits the two. The loop runs in
the daemon with the keys. Each command runs in a container with no network, no secrets and no
writable path outside the repo and `/tmp`, and the container stops itself after 15 minutes. A
host that can't start containers, such as Railway, gets a weaker version of this, which the
system section describes.

The command policy in `execute()` is not that boundary. It refuses what its shell parser can't
reason about and blocks a fixed list of commands and paths, but `pnpm test` runs the repo's
scripts, configs and test files, all of which the agent can edit. The policy keeps an honest
agent on track and counts what it tried. The sandbox is what holds when a command gets past it
([evaluation-method.md](evaluation-method.md#sandbox-and-threat-model)).

The agent's task text is untrusted too. The report is built from a production error, which an
outside user can shape (#174). A Tier 2 run also copies what the model writes from the report
into a public PR, which is why the stored report leaves out bodies, headers and email addresses
([docs/demo-repo.md](../demo-repo.md)).
