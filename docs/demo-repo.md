# Demo repo for agent PRs

Tier 2 runs push to a separate repo, not this one (#10): `atontalapur/page-demo`. The node
daemon commits the agent's changes to `pageagents/<runId>` there and opens a PR against
`main`, as a bot account. A person reviews, approves and merges. This page sets up the
repo, the rules that keep agents off `main`, and the bot's token.

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
whole files.

## 2. Rulesets

Two rulesets, both with no bypass actors, so they apply to the token's owner as well.

`main`: no deletion, no force push, and merging needs a PR with one approving review. The
bot opens every agent PR, and an author can't approve their own PR, so the bot's token can
never merge one. The repo owner reviews, approves and merges.

The repo is public because rulesets on a private repo need a paid plan.

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

## 3. Bot account and token

Agent PRs come from a separate account, so the owner can approve them. GitHub doesn't let
anyone approve their own PR, and a token on the owner's account would make the owner the
author of every agent PR.

1. Create a GitHub account for the bot, such as `page-agents-bot`.
2. Invite it with Write access, then accept the invite from the bot account:
   `gh api -X PUT repos/<owner>/page-demo/collaborators/<bot> -f permission=push`
3. On the bot account, create a classic token with only the `public_repo` scope, and an
   expiry date. A fine-grained token won't work here: it can't reach a repo owned by another
   personal account. The bot has write access to `page-demo` and nothing else, so in
   practice this token can only push there. The rulesets hold it to `pageagents/*` and keep
   it from merging. Without admin rights it can't change the rulesets.

Then, in `page.ai/.env` (the node daemon reads it; see `.env.example`):

```sh
GITHUB_TOKEN=ghp_...
GITHUB_REPO=<owner>/page-demo
```

## 4. Check it

The card is done when a Tier 2 run opens a PR on the demo repo from a `pageagents/*` branch,
and the same tools are refused and logged at Tier 1. After the first real Tier 2 run:

```sh
gh pr list -R <owner>/page-demo --head pageagents/<runId>
psql "$DATABASE_URL" -c "select seq, kind, allowed, exit_code from steps where run_id = '<runId>' and kind = 'host_tool'"
```

To confirm the rulesets hold for the bot, try pushing a branch outside `pageagents/` as the
bot. GitHub should refuse.
