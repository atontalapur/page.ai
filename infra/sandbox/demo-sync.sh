#!/bin/sh
# Puts page-demo `main` on the demo sandbox's baseline tree (#115): the sandbox image with
# one seeded bug. Run it to seed `main` the first time, after a demo PR merges (the reset),
# and whenever apps/demo-app changes here.
#
#   infra/sandbox/demo-sync.sh [scenario] [repo]
#
# Defaults: 001-bad-currency-code and atontalapur/page-demo. Builds both images, then opens
# a PR on the demo repo from a `pageagents/demo-reset-*` branch that replaces the whole tree.
# The `main` ruleset allows no direct push, so the owner merges that PR. Needs docker, git
# and gh (signed in as the owner). Run from the page.ai repo root.
set -eu

scenario=${1:-001-bad-currency-code}
repo=${2:-atontalapur/page-demo}
[ -f "scenarios/$scenario/break.sh" ] || { echo "no scenarios/$scenario/break.sh" >&2; exit 1; }
if node -e 'process.exit(require("./eval/split.json").heldOut.includes(process.argv[1]) ? 0 : 1)' \
  "$scenario"; then
  echo "$scenario is held out (eval/split.json); pick a dev bug" >&2
  exit 1
fi

docker build -q -f infra/sandbox/Dockerfile -t page-sandbox . >/dev/null
docker build -q -f infra/sandbox/demo.Dockerfile --build-arg "SCENARIO=$scenario" \
  -t page-sandbox:demo . >/dev/null

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh repo clone "$repo" "$work/repo" -- -q
cd "$work/repo"
git rm -rq --ignore-unmatch .
docker run --rm --entrypoint git page-sandbox:demo archive HEAD | tar -x
git add -A
if git diff --cached --quiet; then
  echo "$repo main already matches page-sandbox:demo ($scenario)"
  exit 0
fi

branch="pageagents/demo-reset-$(date -u +%Y%m%d%H%M%S)"
git switch -qc "$branch"
git commit -qm "chore: reset to the demo baseline ($scenario seeded)"
git push -q origin "$branch"
gh pr create -R "$repo" --base main --head "$branch" \
  --title "chore: reset to the demo baseline ($scenario seeded)" \
  --body "Puts \`main\` back on the tree of \`page-sandbox:demo\`, built with \`$scenario\` seeded, so the next agent PR's diff is only the fix. Opened by \`infra/sandbox/demo-sync.sh\`."
echo "Merge it with: gh pr merge -R $repo --squash --delete-branch $branch"
