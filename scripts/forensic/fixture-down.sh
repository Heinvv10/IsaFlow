#!/usr/bin/env bash
# Remove the fixture container BY NAME, and nothing else.
#   usage: bash scripts/forensic/fixture-down.sh [port]        (default port 33150)
# Never `docker prune` of any kind: other sessions share this daemon.
set -euo pipefail
PORT=${1:-33150}
[[ $PORT =~ ^[0-9]{5}$ ]] || { echo "REFUSED: port must be five digits (got '$PORT')" >&2; exit 2; }
NAME=isaflow-forensic-$PORT
LABEL=$(docker inspect -f '{{index .Config.Labels "purpose"}}' "$NAME" 2>/dev/null || true)
[ -n "$LABEL" ] || { echo "[fixture-down] $NAME does not exist; nothing to do"; exit 0; }
[ "$LABEL" = isaflow-integration-fixture ] \
  || { echo "REFUSED: $NAME was not created by fixture-up.sh (purpose='$LABEL')" >&2; exit 2; }
docker rm -f "$NAME" >/dev/null
rm -f "${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}/$NAME.env"
echo "[fixture-down] removed $NAME"
