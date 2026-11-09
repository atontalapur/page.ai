#!/bin/sh
# Stands in for `docker` in DockerSandboxes' unit tests. Appends its argv, one line per
# argument and a blank line after, to $FAKE_DOCKER_LOG. The image or container name
# picks a failure to fake. reap runs several at once, and the shell's printf can split
# a line across writes, so each record is built apart and appended by one `cat`.
for arg in "$@"; do printf '%s\n' "$arg"; done > "$FAKE_DOCKER_LOG.$$"
printf '\n' >> "$FAKE_DOCKER_LOG.$$"
cat "$FAKE_DOCKER_LOG.$$" >> "$FAKE_DOCKER_LOG"
rm -f "$FAKE_DOCKER_LOG.$$"
case "$1" in
  run)
    case " $* " in
      *" missing "*) echo "Unable to find image 'missing:latest' locally" >&2; exit 125 ;;
    esac
    echo 0123456789abcdef ;;
  ps)
    # Lists $FAKE_DOCKER_PS, one name per line; `down` in it fakes a dead daemon.
    case "$FAKE_DOCKER_PS" in
      down) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
    esac
    printf '%s' "$FAKE_DOCKER_PS" ;;
  rm)
    case "$3" in
      *gone*) echo "Error response from daemon: No such container: $3" >&2; exit 1 ;;
      *down*) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
    esac
    echo "$3" ;;
esac
