#!/bin/sh
# Stands in for `su-exec` in UserExecRunner's unit tests. Expects the runner's argv:
#   <user> env -i <VAR=value>... sh -c <ulimit wrapper> <max> sh -c <RUN> page-exec <secs> <command>
# The user picks what to fake: `argv` echoes the argv and the working directory, anything
# else runs <command> under the given env, skipping RUN (macOS has no /proc or busybox timeout).
user="$1"
if [ "$user" = argv ]; then printf '%s\n' "$@"; pwd; exit 0; fi
shift
for last; do :; done
# Everything up to `sh` is `env -i VAR=value...`; run the command under exactly that env.
vars=""
shift 2
while [ "$1" != sh ]; do vars="$vars $1"; shift; done
# shellcheck disable=SC2086
exec env -i $vars sh -c "$last"
