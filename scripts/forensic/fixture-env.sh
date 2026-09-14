#!/usr/bin/env bash
# Print the environment an integration run needs, for `eval "$(...)"`.
#   usage: eval "$(bash scripts/forensic/fixture-env.sh [port])"
# Reads the state file fixture-up.sh wrote; prints nothing and exits 2 if the fixture is not up.
set -euo pipefail
PORT=${1:-33150}
NAME=isaflow-forensic-$PORT
STATE=${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}
FILE=$STATE/$NAME.env
[ -r "$FILE" ] || { echo "REFUSED: $FILE not found — run scripts/forensic/fixture-up.sh $PORT" >&2; exit 2; }
docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -qx true \
  || { echo "REFUSED: container $NAME is not running" >&2; exit 2; }
while IFS= read -r line; do
  [ -n "$line" ] || continue
  printf 'export %s=%q\n' "${line%%=*}" "${line#*=}"
done < "$FILE"
