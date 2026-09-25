#!/usr/bin/env bash
#
# GitHub must run the same gate list as `bun run ci` (R-052).
#
# .github/workflows/ci.yml once hand-listed five of run-ci.sh's steps. Every
# gate added to run-ci.sh after that ran only locally, so a PR could merge
# green on GitHub while failing is-active-filters, migration-rls, the build and
# eight others. The fix is structural: the workflow calls `bun run ci`, so the
# gate list has one home. This check stops the workflow drifting back to a
# hand-maintained list, or quietly neutralising the step.
#
# It runs locally and in the pre-push hook, which is where a workflow edit is
# made; on GitHub it only proves the file it is already running.

set -uo pipefail
cd "$(dirname "$0")/../.."

WF=".github/workflows/ci.yml"
fail=0

if [ ! -f "$WF" ]; then
  echo "ERROR: $WF is missing"
  exit 1
fi

if ! grep -Eq '^[[:space:]]+run:[[:space:]]+bun run ci[[:space:]]*$' "$WF"; then
  echo "ERROR: $WF has no step that runs exactly \`bun run ci\`."
  echo "Call run-ci.sh rather than listing its gates: a hand-kept list drifts."
  fail=1
fi

# A step that cannot fail the job is not a gate.
if grep -Eq '^[[:space:]]*continue-on-error:' "$WF"; then
  echo "ERROR: $WF sets continue-on-error; a gate that cannot fail proves nothing."
  fail=1
fi

exit $fail
