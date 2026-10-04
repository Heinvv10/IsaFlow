#!/usr/bin/env bash
# Proves the R-183 split is a pure move: each body block of the original paystackClient.ts
# (origin/master 1910c157b) is byte-identical to the corresponding block of a new file.
# The only permitted edit is `export` added to paystackFetch.
set -eu
cd "$(dirname "$0")/../../../.."
H=$(git rev-parse "${1:-HEAD}")  # new files are read with git show <sha>:, never from disk
echo "checking commit $H"
S=src/modules/billing/services
O=$(mktemp); git show 1910c157b:$S/paystackClient.ts > "$O"
check() { # <orig-from> <orig-to> <new-file> <new-from>
  local n=$(( $2 - $1 + 1 ))
  if diff <(sed -n "$1,$2p" "$O" | sed 's/^async function paystackFetch/export async function paystackFetch/') <(git show "$H:$S/$3" | sed -n "$4,$(( $4 + n - 1 ))p") >/dev/null; then
    echo "OK   orig $1-$2 == $3 $4-$(( $4 + n - 1 ))"
  else echo "FAIL orig $1-$2 vs $3"; exit 1; fi
}
check 21 86   paystackHttp.ts          10
check 88 319  paystackTransactions.ts  8
check 321 432 paystackSubscriptions.ts 8
diff <(sed -n 1,17p "$O") <(git show "$H:$S/paystackClient.ts" | sed -n 1,17p) >/dev/null && echo "OK   barrel header == orig 1-17" || { echo "FAIL barrel header"; exit 1; }
for f in paystackClient paystackHttp paystackTransactions paystackSubscriptions; do echo "lines $f.ts: $(git show "$H:$S/$f.ts" | wc -l)"; done
