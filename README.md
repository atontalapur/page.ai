# page.ai

[![CI](https://github.com/atontalapur/page.ai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/atontalapur/page.ai/actions/workflows/ci.yml)
[![Sandbox image](https://github.com/atontalapur/page.ai/actions/workflows/sandbox-image.yml/badge.svg?branch=main)](https://github.com/atontalapur/page.ai/actions/workflows/sandbox-image.yml)
[![Scenarios](https://github.com/atontalapur/page.ai/actions/workflows/scenarios.yml/badge.svg?branch=main)](https://github.com/atontalapur/page.ai/actions/workflows/scenarios.yml)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![pnpm 12](https://img.shields.io/badge/pnpm-12-F69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![TypeScript 6](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![NestJS 12](https://img.shields.io/badge/NestJS-12-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![PostgreSQL 18](https://img.shields.io/badge/PostgreSQL-18-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Vitest 5](https://img.shields.io/badge/Vitest-5-6E9F18?logo=vitest&logoColor=white)](https://vitest.dev)

[Problem and background](#problem-and-background) · [Initial system design](#initial-system-design) · [Resources and budget](#resources-and-budget) · [Timeline](#timeline) · [Team](#team)

**PageAgents** is a swarm of tiered AI agents that takes first response to production errors off the on-call engineer: it detects, diagnoses, and patches bugs, and calls a human only to watch the pipeline.

## Problem and background

On-call engineers get paged for routine errors (a null check, a bad config value, a failing third-party call), each costing a context switch, log digging, and a patch. PostHog captures the exception and context but stops at alerting, while coding agents can now write passing patches. PageAgents turns the error report into the agent's task, limited by what each tier can safely touch.

## Initial system design

1. **Ingest.** A PostHog webhook posts new and spiking exceptions to a FastAPI receiver queue.
2. **Error-tracking agent.** Dedupes, classifies (frontend, backend/API, database, infra/config), sets severity, and calls on-call via Twilio with a dashboard link.
3. **Swarm.** The orchestrator spawns specialist fix agents, each in an isolated container with a repo clone.
4. **Tiers.** Agents start at Tier 1 and score confidence (reproduced, tests pass, self-assessed); below threshold, the issue escalates a tier.
5. **Tools.** CLI toolkits (git, gh, posthog, docker, tests) behind a per-tier allowlist that logs every call.
6. **Dashboard.** A Next.js view of each agent's tier, confidence, tool log, and diff, with chat and kill.

## Resources and budget

Total: **$95** for the quarter. Railway and OpenRouter accounts already exist; the testbed is a Next.js + Postgres demo app with 30 seeded bugs.

| Item                             | Budget | Use                                          |
| -------------------------------- | ------ | -------------------------------------------- |
| OpenRouter                       | $60    | Agent calls, cheap to strong models by tier  |
| Railway                          | $15    | Receiver, orchestrator, sandboxes, dashboard |
| Twilio                           | $10    | Calls and SMS to on-call                     |
| PostHog, GitHub, FastAPI, Docker | $0     | Error tracking, repo, CI, services           |
| Buffer                           | $10    | Evaluation overruns                          |

## Timeline

| Week | Milestone                                                                                       |
| ---- | ----------------------------------------------------------------------------------------------- |
| 5    | Demo app, PostHog webhook, error-tracking agent with Twilio, CLI allowlist wrapper              |
| 6    | Orchestrator, Tier 1–2 agents, confidence scoring and escalation; dashboard live view and diffs |
| 7    | Dashboard approval, query and kill; Tier 3 agents; end-to-end integration                       |
| 8    | Evaluation on 30 bugs: fix rate per tier, time to fix, false escalations                        |
| 9    | Final demo and report                                                                           |

## Team

- **Daniyal**: dashboard and product lead; demo and report
- **Nidheesh**: ingest pipeline, error-tracking agent, Twilio
- **Arjun**: orchestrator, tiering, escalation logic
- **Advaith**: CLI toolkits, sandboxing, demo app and evaluation
