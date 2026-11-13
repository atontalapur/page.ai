# Demo sandbox image (#115): the sandbox image with one seeded bug folded into its baseline
# commit. The live demo runs on this image, and page-demo `main` holds the same tree, so
# an agent PR's diff is only the fix. Build from the repo root, after the base image:
#   docker build -f infra/sandbox/Dockerfile -t page-sandbox .
#   docker build -f infra/sandbox/demo.Dockerfile -t page-sandbox:demo .
# infra/sandbox/demo-sync.sh does both and puts the tree on page-demo `main`.
#
# Use a dev bug only (eval/split.json). A held-out bug must not be run before the
# held-out eval (#114).
ARG BASE=page-sandbox
FROM ${BASE}
ARG SCENARIO=001-bad-currency-code

# break.sh is bind-mounted, not copied, so nothing outside /workspace changes. Amending
# keeps one baseline commit, so the agent's diff starts from the bugged tree.
RUN --mount=type=bind,source=scenarios/${SCENARIO}/break.sh,target=/tmp/break.sh \
    sh /tmp/break.sh \
  && git add -A \
  && git -c user.name=sandbox -c user.email=sandbox@page.invalid commit -q --amend -m baseline

LABEL org.opencontainers.image.description="PageAgents demo sandbox (seeded: ${SCENARIO})"
