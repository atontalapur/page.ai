# Demo repo for agent PRs

Tier 2 runs push to a separate repo, not this one (#10). The node daemon commits the agent's
changes to `pageagents/<runId>` there and opens a PR against `main`. This page sets up the
repo, the rules that keep agents off `main`, and the token.

## 1. Create the repo with the sandbox baseline

The daemon copies changed files across by path, so the demo repo's `main` must hold exactly
what the sandbox's `/workspace` starts with. Export it from the image instead of copying by
hand:

```sh
docker build -f infra/sandbox/Dockerfile -t page-sandbox .
gh repo create <owner>/page-demo --private
mkdir page-demo && cd page-demo && git init -b main
docker run --rm --entrypoint git page-sandbox archive HEAD | tar -x
git add -A && git commit -m "chore: sandbox baseline"
git remote add origin git@github.com:<owner>/page-demo.git && git push -u origin main
```

Do this again whenever `apps/demo-app` changes here and the sandbox image is rebuilt. If the
two drift, a PR can undo `main`'s side of any file the agent touched, since a push writes
whole files.

## 2. Rulesets

Two rulesets, both with no bypass actors, so they apply to the token's owner as well.

`main`: no deletion, no force push, and merging needs a PR with one approving review. A PR
author can't approve their own PR, so the token can open PRs but never merge one. A teammate
reviews and merges.

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
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": true,
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

## 3. Token

Create a fine-grained token at GitHub, Settings, Developer settings, Fine-grained tokens:

- Repository access: only `<owner>/page-demo`.
- Permissions: Contents read and write, Pull requests read and write. Metadata read comes
  with them. Nothing else, in particular not Administration, so the token can't edit the
  rulesets.
- An expiry date. Put a reminder in the tracking issue.

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
