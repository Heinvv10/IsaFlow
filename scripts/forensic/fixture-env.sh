#!/usr/bin/env bash
# Print the environment an integration run needs, for `eval "$(...)"`.
#   usage: eval "$(bash scripts/forensic/fixture-env.sh [port])"
# Reads the state file fixture-up.sh wrote; prints nothing and exits 2 if the fixture is not up.
set -euo pipefail
STATE=${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}
# No port: the most recently created fixture on this machine, which is what `fixture-up.sh` with no
# argument just allocated. A fixed default sends every session to the same container.
if [ $# -ge 1 ]; then PORT=$1
else
  LATEST=$(ls -t "$STATE"/isaflow-forensic-*.env 2>/dev/null | head -1)
  [ -n "$LATEST" ] || { echo "REFUSED: no fixture recorded in $STATE — run scripts/forensic/fixture-up.sh" >&2; exit 2; }
  PORT=$(basename "$LATEST" .env | sed 's/isaflow-forensic-//')
fi
NAME=isaflow-forensic-$PORT
FILE=$STATE/$NAME.env
[ -r "$FILE" ] || { echo "REFUSED: $FILE not found — run scripts/forensic/fixture-up.sh $PORT" >&2; exit 2; }
docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -qx true \
  || { echo "REFUSED: container $NAME is not running" >&2; exit 2; }
while IFS= read -r line; do
  [ -n "$line" ] || continue
  printf 'export %s=%q\n' "${line%%=*}" "${line#*=}"
done < "$FILE"
