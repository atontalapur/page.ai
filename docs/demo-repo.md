# Demo repo for agent PRs

Tier 2 runs push to a separate repo, not this one (#10): `atontalapur/page-demo`. The node
daemon commits the agent's changes to `pageagents/<runId>` there and opens a PR against
`main`. The repo owner reviews the PR and merges it. This page sets up the
repo, the rules that keep agents off `main`, and the token.

## 1. Create the repo with the sandbox baseline

The daemon copies changed files across by path, so the demo repo's `main` must hold exactly
what the sandbox's `/workspace` starts with. Export it from the image instead of copying by
hand:

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
gh repo create <owner>/page-demo --public
mkdir page-demo && cd page-demo && git init -b main
docker run --rm --entrypoint git page-sandbox archive HEAD | tar -x
git add -A && git commit -m "chore: sandbox baseline"
git remote add origin git@github.com:<owner>/page-demo.git && git push -u origin main
```

Do this again whenever `apps/demo-app` changes here and the sandbox image is rebuilt. If the
two drift, a PR can undo `main`'s side of any file the agent touched, since a push writes
whole files. Once the repo exists, `infra/sandbox/demo-sync.sh` (section 5) does the resync.

## 5. The seeded demo bug, and resetting after a demo

For a live demo, the deployed app has to throw, so `main` carries one seeded bug, and the
sandbox has to start from the same bugged tree (#115). `infra/sandbox/demo.Dockerfile`
builds `page-sandbox:demo`: the sandbox image with a scenario's `break.sh` folded into the
baseline commit. The daemon runs on it:

```sh
SANDBOX_IMAGE=page-sandbox:demo
```

The default bug is `001-bad-currency-code` (Tier 1, fixed in every dev eval run). Use a dev
bug only. The script refuses held-out bugs (`eval/split.json`), since running one before the
held-out eval spends it (#114). The demo image fails `smoke.sh` on the demo app's tests,
because the bug is there. That is expected.

`demo-sync.sh` builds both images and opens a PR on page-demo that puts `main` on the demo
image's tree. Run it once to seed `main`, and again after every demo PR merges to put the
bug back:

```sh
infra/sandbox/demo-sync.sh                     # 001-bad-currency-code on atontalapur/page-demo
infra/sandbox/demo-sync.sh 009-checkout-enabled-default
gh pr merge -R atontalapur/page-demo --squash --delete-branch pageagents/demo-reset-<time>
```

The PR comes from a `pageagents/demo-reset-*` branch, the only branches the rulesets let
anyone create, and the owner merges it like any other PR. If `main` already matches, the
script says so and opens nothing. Leave an agent's demo PR unmerged and closing it works as
well, but a merged one needs the reset before the next demo. Restart the deployed app on the
reset tree too, or it keeps serving the fix.

## 2. Rulesets

Two rulesets, both with no bypass actors, so they apply to the token's owner as well.

`main`: no deletion, no force push, and every change goes through a PR. No approval is
required: the token is the owner's, so agent PRs are authored by the owner, and GitHub never
lets an author approve their own PR. The owner reviews the diff and merges. The agent has no
merge tool, so it can't merge, but the token itself could. A leaked token is write access to
`main`, so give it a short expiry (section 3) and revoke it at once if the daemon's host is
ever in doubt. A bot account or a GitHub App with one required approval would close this
gap; it was traded away so the owner can approve and merge with no second account.

The repo is public because rulesets on a private repo need a paid plan. Everything a Tier 2
run writes is published: commit messages, the PR title and body, and every pushed file. The
model writes all of it from the fix job's `report`, so anything in a report (a request body,
a header, a user's email) can end up in a public PR. Triage (#30) has to strip request
bodies, headers and user fields before a report reaches the agent.

```sh
gh api -X POST repos/<owner>/page-demo/rulesets --input - <<'JSON'
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
JSON
```

Agent branches only: no one creates, updates or deletes a branch other than `main` and
`pageagents/*`. The daemon also refuses to write any other branch, but this is the rule that
holds.

```sh
gh api -X POST repos/<owner>/page-demo/rulesets --input - <<'JSON'
{
  "name": "agent branches only",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~ALL"],
      "exclude": ["~DEFAULT_BRANCH", "refs/heads/pageagents/**"]
    }
  },
  "rules": [{ "type": "creation" }, { "type": "update" }, { "type": "deletion" }]
}
JSON
```

The daemon refuses to push a path the edit tool refuses (`.github/`, `.git/`,
`node_modules/`, `..`), so a test run can't add a workflow, a composite action,
`CODEOWNERS` or `dependabot.yml`. The token's missing Workflows permission only covers
`.github/workflows/`.

## 3. Token

Create a fine-grained token at GitHub, Settings, Developer settings, Fine-grained tokens:

- Repository access: only `<owner>/page-demo`.
- Permissions: Contents read and write, Pull requests read and write. Metadata read comes
  with them. Nothing else, in particular not Administration, so the token can't edit the
  rulesets.
- An expiry of days, not months: 7 to 14. Put a reminder in the tracking issue.

Then, in the node daemon's `.env`:

```sh
GITHUB_TOKEN=github_pat_...
GITHUB_REPO=<owner>/page-demo
```

## 4. Check it

The card is done when a Tier 2 run opens a PR on the demo repo from a `pageagents/*` branch,
and the same tools are refused and logged at Tier 1. After the first real Tier 2 run:

```sh
gh pr list -R <owner>/page-demo --head pageagents/<runId>
psql "$DATABASE_URL" -c "select seq, kind, allowed, exit_code from steps where run_id = '<runId>' and kind = 'host_tool'"
```

To confirm the rulesets hold for the token itself, try pushing a branch outside
`pageagents/` with it. GitHub should refuse.
