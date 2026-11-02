#!/bin/sh
# Stands in for `docker` in DockerExecRunner's unit tests. Expects the runner's argv:
#   exec -i -e PAGE_EXEC=<id> -w <dir> <container> timeout -s KILL <secs> sh -c <command>
# and runs `sh -c <command>` locally. The container name picks a failure to fake.

# The cleanup after a timeout: exec <container> sh -c <script> <id>.
if [ "$3" = sh ]; then exit 0; fi
container="$7"
# Echo the argv the runner built, one per line.
if [ "$container" = argv ]; then printf '%s\n' "$@"; exit 0; fi
shift 11
case "$container" in
  missing) echo "Error response from daemon: No such container: missing" >&2; exit 1 ;;
  killed) cat >/dev/null; exit 137 ;;
  hang) exec sleep 30 ;;
  signal) kill -TERM $$ ;;
  *) exec "$@" ;;
esac
