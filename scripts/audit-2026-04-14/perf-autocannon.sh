#!/usr/bin/env bash
# Performance audit — autocannon load tests
# Read-only: measures existing endpoints. Does NOT modify anything.
set -euo pipefail

source /tmp/isaflow-admin-token.env
BASE="${BASE:-http://localhost:3200}"
HDR="Cookie: isaflow_auth=$TOKEN"
DURATION="${DURATION:-20}"  # seconds per endpoint
CONN="${CONN:-10}"          # concurrent connections

CB="d27bac33-cdc0-4e58-bf6b-709c1597d41c"   # Brightsphere (heavy)
CL="00000000-0000-0000-0000-000000000001"   # ISAFlow Demo (light)
FP_DEMO="ea58d459-7fe5-4b56-866e-02347c6ea939"   # Demo fiscal period (March 2027)

OUT_DIR="$(dirname "$0")/results"
mkdir -p "$OUT_DIR"

run(){
  local name="$1"; local path="$2"
  echo "=== $name ==="
  echo "URL: $BASE$path"
  bunx autocannon -d "$DURATION" -c "$CONN" -H "$HDR" "$BASE$path" 2>&1 | tee "$OUT_DIR/$name.txt" | tail -22
  echo
}

# Lists — heavy company
run "bank-tx-list-B50"                "/api/accounting/bank-transactions?companyId=$CB&limit=50"
run "bank-tx-list-B200"               "/api/accounting/bank-transactions?companyId=$CB&limit=200"
run "customer-invoices-list-B"        "/api/accounting/customer-invoices-list?companyId=$CB&limit=50"
run "supplier-invoices-list-B"        "/api/accounting/supplier-invoices?companyId=$CB&limit=50"
run "customers-B"                     "/api/accounting/customers?companyId=$CB&limit=50"
run "suppliers-list-B"                "/api/accounting/suppliers-list?companyId=$CB&limit=50"
run "coa-B"                           "/api/accounting/chart-of-accounts?companyId=$CB"

# Reports — heavy company
run "cash-flow-B"                     "/api/accounting/reports-cash-flow?companyId=$CB"
run "ar-aging-B"                      "/api/accounting/ar-aging?companyId=$CB"
run "ap-aging-B"                      "/api/accounting/ap-aging?companyId=$CB"
run "journal-entries-B"               "/api/accounting/reports-journal-entries?companyId=$CB"
run "income-statement-B"              "/api/accounting/reports-income-statement?companyId=$CB&period_start=2026-01-01&period_end=2026-04-14"
run "executive-summary-B"             "/api/accounting/reports-executive-summary?companyId=$CB"
run "kpi-scorecard-B"                 "/api/accounting/reports-kpi-scorecard?companyId=$CB"
run "ratios-B"                        "/api/accounting/reports-ratios?companyId=$CB"

# Reports — demo (has fiscal period, so TB works here)
run "trial-balance-demo"              "/api/accounting/reports-trial-balance?companyId=$CL&fiscal_period_id=$FP_DEMO"

echo "All done. Results in $OUT_DIR"
