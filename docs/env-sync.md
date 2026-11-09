# Shared secrets

The team's shared secrets live in `.env.shared`, encrypted with [dotenvx](https://dotenvx.com)
and committed. Each dev's `.env` stays local and gitignored. `scripts/env-sync.js` moves values
between the two and never prints them.

## First time

1. Get `DOTENV_PRIVATE_KEY_SHARED` from a teammate over a private channel (a DM, not an issue or
   PR).
2. Put it in `.env.keys` at the repo root, which is gitignored:

   ```
   DOTENV_PRIVATE_KEY_SHARED=<key>
   ```

3. Run `pnpm env:pull`. It creates `.env` from `.env.example` if you don't have one.

## Commands

| Command                  | What it does                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm env:pull`          | Decrypts `.env.shared` and writes its values into `.env`, then adds any setting from `.env.example` that `.env` lacks. Settings already in `.env` stay. Needs the private key. |
| `pnpm env:share KEY ...` | Copies each `KEY` from your `.env` into `.env.shared`, encrypted. Needs only the public key, which is in `.env.shared`.                                                        |

After `env:share`, commit `.env.shared` in a PR. Teammates run `pnpm env:pull` once it merges.

## Settings that aren't secret

Ports, URLs, `OPENROUTER_MODEL`, `GITHUB_REPO` and `USE_FAKE_ADAPTERS` live in plain text in
`.env.example`. `pnpm env:pull` adds any of them your `.env` doesn't set yet, with the example
value, so a setting added later reaches everyone on their next pull. A value you already set,
such as a different `POSTGRES_PORT`, is never overwritten. To change a default for the team,
edit `.env.example` in a PR.

## What is shared

`NODE_SHARED_SECRET`, `POSTHOG_WEBHOOK_SECRET` and `OPENROUTER_API_KEY`. The list is
`SHARED_KEYS` in `scripts/env-sync.js`. To share a new key, add it there first.

Anyone can encrypt a value with the public key, so `env:pull` treats `.env.shared` as untrusted.
It refuses keys outside `SHARED_KEYS` and any value that isn't encrypted, and it writes each
decrypted value as plain text without expanding `$VAR` or running `$(...)`.

`GITHUB_TOKEN` is not shared. Each dev makes their own fine-grained token, as in
[demo-repo.md](demo-repo.md). A shared one would let every holder merge on `page-demo`, and its
PRs would all show one person as author.

## If the private key leaks

The repo is public, so anyone can read every past version of `.env.shared`. A leaked key
decrypts all of them. Rotate each shared secret at its source (OpenRouter, PostHog, and a new
`openssl rand -hex 32` for the others), make a new key pair, and share everything again:

```
rm .env.shared .env.keys
pnpm env:share NODE_SHARED_SECRET POSTHOG_WEBHOOK_SECRET OPENROUTER_API_KEY
```

Then send the new `.env.keys` value to each teammate.
