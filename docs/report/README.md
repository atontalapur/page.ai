# Final report draft

The team's final report lives in this folder. Each section is a Markdown file here, added
or changed through a PR that one teammate reviews. That review is the "reviewed by one
teammate" step the report cards ask for. Contribution notes are due Dec 4.

Owners below are proposals taken from who holds each area's cards. Swap them in review if
they're wrong.

| Section                                                    | Owner    | Status                                   | File                                                         |
| ---------------------------------------------------------- | -------- | ---------------------------------------- | ------------------------------------------------------------ |
| Problem and background                                     | open     | not started; the repo README has a start | [README](../../README.md#problem-and-background)             |
| System: ingest, triage, paging and the issue state machine | Nidheesh | not started                              |                                                              |
| System: agent loop and escalation thresholds               | Arjun    | not started                              |                                                              |
| System: node daemon, sandbox, tiered toolkit and demo app  | Advaith  | not started                              |                                                              |
| System: dashboard                                          | Daniyal  | not started                              |                                                              |
| Evaluation method                                          | Advaith  | reviewed (#17)                           | [evaluation-method.md](evaluation-method.md)                 |
| Results (dev, held-out and ops)                            | Advaith  | reviewed (#17)                           | [evaluation-method.md#results](evaluation-method.md#results) |
| Discussion and limitations                                 | open     | not started                              |                                                              |
| Appendix: eval preregistration                             | Advaith  | done                                     | [eval-prereg.md](eval-prereg.md)                             |
| Contributions                                              | everyone | ongoing, due Dec 4                       | [contributions.md](../contributions.md)                      |

Charts for the Results are in [charts/dev](charts/dev), [charts/held-out](charts/held-out) and
[charts/ops](charts/ops), rendered by `pnpm eval:charts`.
