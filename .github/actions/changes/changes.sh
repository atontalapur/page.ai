#!/usr/bin/env bash
# Sets run (and files) in GITHUB_OUTPUT for action.yml; see its inputs and outputs.
# A failed diff fails the step: it must never read as "nothing changed".
set -euo pipefail

pats="$(grep -v '^[[:space:]]*$' <<<"$PATTERNS" || true)"
if [ -z "$pats" ]; then
  echo "::error::no patterns given"
  exit 1
fi

case "$EVENT" in
  pull_request)
    if [ -z "${BASE:-}" ]; then
      echo "::error::no pull_request.base.sha"
      exit 1
    fi
    range=("$BASE...HEAD")
    ;;
  push)
    if [ -z "${BEFORE:-}" ] || [ -z "${BEFORE//0/}" ]; then
      echo "No commit before this push to diff against, so every input counts as changed."
      range=()
    elif ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then
      # A force push can leave the old tip out of the clone.
      echo "::warning::$BEFORE is not in the clone, so every input counts as changed."
      range=()
    else
      range=("$BEFORE" HEAD)
    fi
    ;;
  *)
    echo "Nothing to diff for a $EVENT event, so every input counts as changed."
    range=()
    ;;
esac

if [ "${#range[@]}" = 0 ]; then
  echo "run=true" >>"$GITHUB_OUTPUT"
  echo "files=" >>"$GITHUB_OUTPUT"
  exit 0
fi

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "::error::shallow clone; check out with fetch-depth: 0"
  exit 1
fi

# Its own assignment, so a failed diff ends the step under set -e.
# quotePath off, so a non-ASCII path isn't quoted and still matches its pattern.
changed="$(git -c core.quotePath=false diff --name-only "${range[@]}")"
files=""
if [ -n "$changed" ]; then
  # grep exits 1 on no match, which is fine, and 2 on an error, which is not.
  status=0
  files="$(grep -E -f <(echo "$pats") <<<"$changed")" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "::error::grep failed with exit $status"
    exit 1
  fi
fi

echo "Changed inputs:"
echo "${files:-  none}"
if [ -n "$files" ]; then
  echo "run=true" >>"$GITHUB_OUTPUT"
else
  echo "run=false" >>"$GITHUB_OUTPUT"
fi
delim="EOF_$(openssl rand -hex 16)"
{
  echo "files<<$delim"
  echo "$files"
  echo "$delim"
} >>"$GITHUB_OUTPUT"
