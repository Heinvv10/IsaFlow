#!/usr/bin/env bash
# Migration order for bash, the same as compareMigrations in
# scripts/lib/migrationFiles.ts (tests/unit/scripts/migrationOrder.test.ts holds
# them equal): the version's digits as an integer, then its letters
# (none < a < az < b < z < za), then the filename. A string sort, a glob or [[ a < b ]] puts
# 1000_ before 100_. sort -n reads 099 as 99 (no octal), unlike $(( 099 )).
# Source it, then: printf '%s\n' <names> | mig_order

# Reads filenames on stdin, writes them in migration order.
mig_order() {
  sed -E 's/^([0-9]+)([a-z]{0,2})_.*$/\1\t\2\t&/' | LC_ALL=C sort -t "$(printf '\t')" -k1,1n -k2,2 -k3,3 | awk -F '\t' '{ print $NF }'
}

# Reads filenames on stdin, writes those that sort strictly before $1, in order.
mig_below() {
  { cat; printf '%s\n' "$1"; } | LC_ALL=C sort -u | mig_order | awk -v top="$1" '$0 == top { exit } { print }'
}
