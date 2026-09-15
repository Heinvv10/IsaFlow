#!/usr/bin/env bash
# Remove the fixture container BY NAME, and nothing else.
#   usage: bash scripts/forensic/fixture-down.sh [port] [--force]   (no port: this machine's most recent)
# Never `docker prune` of any kind: other sessions share this daemon.
set -euo pipefail
STATE=${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}
# No port: the fixture THIS session most recently created, never a bare default. Defaulting to a
# fixed port is how one session tore down another's while it was testing against it.
if [ $# -ge 1 ]; then PORT=$1
else
  LATEST=$(ls -t "$STATE"/isaflow-forensic-*.env 2>/dev/null | head -1)
  [ -n "$LATEST" ] || { echo "REFUSED: no fixture recorded in $STATE — pass a port explicitly if you know it" >&2; exit 2; }
  PORT=$(basename "$LATEST" .env | sed 's/isaflow-forensic-//')
  echo "[fixture-down] no port given; using the most recent fixture on this machine: $PORT"
fi
[[ $PORT =~ ^[0-9]{5}$ ]] || { echo "REFUSED: port must be five digits (got '$PORT')" >&2; exit 2; }
NAME=isaflow-forensic-$PORT
LABEL=$(docker inspect -f '{{index .Config.Labels "purpose"}}' "$NAME" 2>/dev/null || true)
[ -n "$LABEL" ] || { echo "[fixture-down] $NAME does not exist; nothing to do"; exit 0; }
[ "$LABEL" = isaflow-integration-fixture ] \
  || { echo "REFUSED: $NAME was not created by fixture-up.sh (purpose='$LABEL')" >&2; exit 2; }
# Refuse a fixture this machine's scripts did not create, or one whose creating run is not the one
# that wrote the state file — that is a peer's, and removing it destroys a run in progress.
CONTAINER_OWNER=$(docker inspect -f '{{index .Config.Labels "owner"}}' "$NAME" 2>/dev/null || true)
STATE_OWNER=$(grep -s '^ISAFLOW_FIXTURE_OWNER=' "$STATE/$NAME.env" | cut -d= -f2 || true)
if [ "${1:-}" != "--force" ] && [ "${2:-}" != "--force" ] \
   && [ -n "$CONTAINER_OWNER" ] && [ "$CONTAINER_OWNER" != "$STATE_OWNER" ]; then
  echo "REFUSED: $NAME was created by a different run (owner ${CONTAINER_OWNER:0:8}…, state file says ${STATE_OWNER:0:8}…)." >&2
  echo "         It is probably another session's fixture and may be in use. Re-run with --force if you are certain." >&2
  exit 2
fi
docker rm -f "$NAME" >/dev/null
rm -f "${ISAFLOW_FIXTURE_STATE:-$HOME/.cache/isaflow-fixture}/$NAME.env"
echo "[fixture-down] removed $NAME"
