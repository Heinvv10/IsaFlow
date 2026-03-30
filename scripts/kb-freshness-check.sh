#!/bin/bash
# KB Freshness Check — Detect stale knowledge base files
# Usage: bash scripts/kb-freshness-check.sh [threshold_days]

set -euo pipefail

THRESHOLD=${1:-30}
STALE=0

echo "=== ISAFlow KB Freshness Check ==="
echo "Threshold: ${THRESHOLD} days"
echo ""

# Check module .claude.md files
echo "Module Context Files:"
for dir in src/modules/*/; do
  name=$(basename "$dir")
  if [ -f "$dir/.claude.md" ]; then
    age=$(( ( $(date +%s) - $(stat -c %Y "$dir/.claude.md") ) / 86400 ))
    if [ "$age" -gt "$THRESHOLD" ]; then
      echo "  ⚠️  $name/.claude.md — ${age} days old (stale)"
      STALE=$((STALE+1))
    else
      echo "  ✅ $name/.claude.md — ${age} days old"
    fi
  else
    echo "  ❌ $name — MISSING .claude.md"
    STALE=$((STALE+1))
  fi
done

echo ""
echo "Counts:"
echo "  Modules:    $(ls -d src/modules/*/ | wc -l)"
echo "  Services:   $(find src/modules -name '*Service.ts' -o -name '*service.ts' | wc -l)"
echo "  API Routes: $(find pages/api/accounting -name '*.ts' 2>/dev/null | wc -l)"
echo "  Pages:      $(find pages/accounting -name '*.tsx' 2>/dev/null | wc -l)"
echo "  Migrations: $(ls scripts/migrations/sql/*.sql 2>/dev/null | wc -l)"
echo ""

if [ "$STALE" -gt 0 ]; then
  echo "❌ ${STALE} stale/missing KB files found"
  exit 1
else
  echo "✅ All KB files fresh"
  exit 0
fi
