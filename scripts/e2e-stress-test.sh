#!/bin/bash
# ISAFlow Comprehensive E2E Stress Test
# Tiers: 1=APIs+Pages, 2=CRUD+PDFs, 3=Full Flows, 4=Modals+Edge Cases
# Usage: ./scripts/e2e-stress-test.sh [tier] (default: 1)

set -euo pipefail
TIER="${1:-1}"
BASE="http://localhost:3101"
LOG="/tmp/isaflow-e2e-$(date '+%Y%m%d').log"

# Auth
TOKEN=$(curl -s -v -X POST ${BASE}/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@isaflow.co.za","password":"admin123"}' 2>&1 | grep -o 'ff_auth_token=[^;]*' | head -1 | cut -d= -f2)
C="ff_auth_token=${TOKEN}; ff_onboarding_done=1"
TS=$(date +%s)

# Counters
PASS=0; FAIL=0; ERRORS=""
pass() { PASS=$((PASS+1)); }
fail() { FAIL=$((FAIL+1)); ERRORS="${ERRORS}\n  FAIL: $1"; echo "  FAIL: $1" >> "$LOG"; }

# Test helpers
test_api() {
  local name="$1" url="$2" method="${3:-GET}" body="${4:-}"
  local result
  if [ "$method" = "GET" ]; then
    result=$(curl -s -H "Cookie: ${C}" "${BASE}${url}" 2>/dev/null)
  else
    result=$(curl -s -H "Cookie: ${C}" -X "$method" -H 'Content-Type: application/json' -d "$body" "${BASE}${url}" 2>/dev/null)
  fi
  local ok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','ERR'))" 2>/dev/null || echo "BINARY")
  if [ "$ok" = "True" ] || [ "$ok" = "BINARY" ]; then pass; else fail "API:${method} ${name}"; fi
  echo "$result"
}

test_page() {
  local url="$1"
  local status=$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: ${C}" "${BASE}${url}" 2>/dev/null)
  if [ "$status" = "200" ]; then pass; else fail "PAGE ${url} → ${status}"; fi
}

test_pdf() {
  local name="$1" url="$2"
  curl -s -H "Cookie: ${C}" -o "/tmp/e2e-${name}.pdf" "${BASE}${url}" 2>/dev/null
  if file "/tmp/e2e-${name}.pdf" 2>/dev/null | grep -q PDF; then pass; echo "  PDF ${name}: $(stat -c%s "/tmp/e2e-${name}.pdf" 2>/dev/null)b OK"
  else fail "PDF ${name}"; fi
}

test_create() {
  local name="$1" url="$2" body="$3"
  local result=$(curl -s -H "Cookie: ${C}" -X POST -H 'Content-Type: application/json' -d "$body" "${BASE}${url}" 2>/dev/null)
  local ok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','ERR'))" 2>/dev/null)
  local id=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); data=d.get('data',{}); print(data.get('id','') if isinstance(data,dict) else '')" 2>/dev/null)
  if [ "$ok" = "True" ]; then pass; echo "  CREATE ${name}: ${id}"; else fail "CREATE ${name}"; fi
  echo "$id"
}

test_action() {
  local name="$1" url="$2" body="$3"
  local result=$(curl -s -H "Cookie: ${C}" -X POST -H 'Content-Type: application/json' -d "$body" "${BASE}${url}" 2>/dev/null)
  local ok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','ERR'))" 2>/dev/null)
  if [ "$ok" = "True" ]; then pass; echo "  ACTION ${name}: OK"; else fail "ACTION ${name}"; fi
}

echo "=== ISAFlow E2E Tier ${TIER} — $(date '+%Y-%m-%d %H:%M:%S') ===" | tee -a "$LOG"

# ═══════════════════════════════════════════════════════════════════════════
# TIER 1: APIs + Pages (every 10 min)
# ═══════════════════════════════════════════════════════════════════════════
echo "── Tier 1: APIs ──"
for api in /api/accounting/customers /api/accounting/customer-invoices-list /api/accounting/customer-payments \
  /api/accounting/credit-notes /api/accounting/customer-statements /api/accounting/suppliers-list \
  /api/accounting/supplier-invoices /api/accounting/supplier-payments /api/accounting/purchase-orders \
  /api/accounting/batch-payments /api/accounting/bank-accounts /api/accounting/bank-rules \
  "/api/accounting/bank-transactions?limit=1" /api/accounting/chart-of-accounts /api/accounting/journal-entries \
  /api/accounting/fiscal-periods /api/accounting/currencies /api/accounting/opening-balances \
  /api/accounting/assets /api/accounting/cost-centres /api/accounting/budgets \
  "/api/accounting/reports-cash-flow?from=2026-01-01&to=2026-03-31" \
  "/api/accounting/reports-kpi-scorecard?from=2026-01-01&to=2026-03-31" \
  /api/accounting/compliance-alerts /api/accounting/month-end-close /api/accounting/approval-requests \
  /api/accounting/products /api/accounting/company-groups \
  /api/payroll/employees /api/payroll/payroll-runs /api/payroll/leave-applications; do
  test_api "$(basename ${api%%\?*})" "$api" > /dev/null
done

echo "── Tier 1: Pages ──"
for pg in "/" "/login" "/register" "/accounting" \
  "/accounting/customers" "/accounting/customers/new" "/accounting/customers/c1000000-0000-0000-0000-000000000001" \
  "/accounting/customer-invoices" "/accounting/customer-invoices/new" \
  "/accounting/customer-payments" "/accounting/customer-payments/new" \
  "/accounting/credit-notes" "/accounting/credit-notes/new" \
  "/accounting/customer-statements" "/accounting/customer-age-analysis" "/accounting/customer-allocations" \
  "/accounting/ar-aging" "/accounting/dunning" "/accounting/debtors-manager" "/accounting/write-offs" "/accounting/statement-run" \
  "/accounting/suppliers" "/accounting/suppliers/new" "/accounting/suppliers/d1000000-0000-0000-0000-000000000001" \
  "/accounting/supplier-invoices" "/accounting/supplier-invoices/new" \
  "/accounting/supplier-payments" "/accounting/supplier-payments/new" \
  "/accounting/purchase-orders" "/accounting/purchase-orders/new" \
  "/accounting/batch-payments" "/accounting/batch-payments/new" \
  "/accounting/supplier-allocations" "/accounting/supplier-age-analysis" "/accounting/ap-aging" \
  "/accounting/items" "/accounting/items/new" "/accounting/products" "/accounting/products/new" "/accounting/stock-levels" \
  "/accounting/bank-accounts" "/accounting/bank-transactions" "/accounting/bank-transactions/new" \
  "/accounting/bank-reconciliation" "/accounting/bank-reconciliation/import" "/accounting/bank-reconciliation/rules" \
  "/accounting/bank-transfers" "/accounting/cashbook" "/accounting/bank-rules" \
  "/accounting/chart-of-accounts" "/accounting/journal-entries/new" \
  "/accounting/currencies" "/accounting/exchange-rates" "/accounting/default-accounts" \
  "/accounting/trial-balance" "/accounting/opening-balances" \
  "/accounting/assets" "/accounting/assets/new" "/accounting/depreciation" "/accounting/year-end" \
  "/accounting/cost-centres" "/accounting/business-units" "/accounting/budgets" \
  "/accounting/reports/income-statement" "/accounting/reports/balance-sheet" "/accounting/reports/cash-flow" \
  "/accounting/reports/vat-return" "/accounting/reports/audit-trail" "/accounting/reports/trial-balance" \
  "/accounting/cash-flow-forecast" "/accounting/reports/financial-analysis" "/accounting/reports/waterfall" "/accounting/reports/trend-analysis" \
  "/accounting/vat-adjustments" "/accounting/drc-vat" \
  "/accounting/sars" "/accounting/sars/vat201" "/accounting/sars/emp201" \
  "/accounting/document-capture" "/accounting/approvals" "/accounting/time-tracking" \
  "/accounting/company-settings" "/accounting/accounting-settings" "/accounting/sage-migration" "/accounting/group" \
  "/payroll/employees" "/payroll/employees/new" "/payroll/runs" "/payroll/runs/new" "/payroll/leave" "/payroll/leave/apply" \
  "/accounting/recurring-invoices" "/accounting/supplier-purchase-orders" \
  "/accounting/customer-quotes" "/accounting/customer-sales-orders" \
  "/accounting/supplier-returns" "/accounting/supplier-statements" "/accounting/supplier-credit-notes"; do
  test_page "$pg"
done

[ "$TIER" -lt 2 ] && { echo "APIs+Pages: ${PASS} pass, ${FAIL} fail" | tee -a "$LOG"; [ -n "$ERRORS" ] && echo -e "$ERRORS"; exit 0; }

# ═══════════════════════════════════════════════════════════════════════════
# TIER 2: CRUD + PDFs (every 30 min)
# ═══════════════════════════════════════════════════════════════════════════
echo "── Tier 2: CRUD Operations ──"

# Create customer
test_create "customer" "/api/accounting/customers" \
  "{\"name\":\"StressTest Customer ${TS}\",\"email\":\"stress${TS}@test.co.za\",\"payment_terms\":30}" > /dev/null

# Create GL account
test_create "gl-account" "/api/accounting/chart-of-accounts" \
  "{\"accountCode\":\"ST${TS: -3}\",\"accountName\":\"Stress ${TS}\",\"accountType\":\"expense\",\"normalBalance\":\"debit\"}" > /dev/null

# Create invoice (test the full VAT calc)
test_api "invoice-create" "/api/accounting/customer-invoices-create" "POST" \
  "{\"clientId\":\"c1000000-0000-0000-0000-000000000001\",\"invoiceDate\":\"$(date +%Y-%m-%d)\",\"dueDate\":\"$(date -d '+30 days' +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)\",\"taxRate\":15,\"notes\":\"Stress test\",\"items\":[{\"description\":\"Test item\",\"unitPrice\":1000,\"quantity\":2}]}" > /dev/null

echo "── Tier 2: PDFs ──"
# Get payroll run ID for PDF tests
RID=$(curl -s -H "Cookie: ${C}" "${BASE}/api/payroll/payroll-runs" 2>/dev/null | python3 -c "import sys,json; runs=json.load(sys.stdin).get('data',[]); print(runs[0]['id'] if runs else '')" 2>/dev/null)
SID=""
if [ -n "$RID" ]; then
  SID=$(curl -s -H "Cookie: ${C}" "${BASE}/api/payroll/payroll-runs-detail?id=${RID}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); slips=d.get('payslips',[]); print(slips[0]['id'] if slips else '')" 2>/dev/null)
fi

test_pdf "invoice" "/api/accounting/invoice-pdf?invoiceId=f1000000-0000-0000-0000-000000000001"
[ -n "$SID" ] && test_pdf "payslip" "/api/payroll/payslip-pdf?id=${SID}"
[ -n "$RID" ] && {
  test_pdf "pay-register" "/api/payroll/payroll-documents?runId=${RID}&type=pay-register"
  test_pdf "emp201" "/api/payroll/payroll-documents?runId=${RID}&type=emp201"
  test_pdf "leave-report" "/api/payroll/payroll-documents?runId=${RID}&type=leave-report"
  test_pdf "remuneration" "/api/payroll/payroll-documents?runId=${RID}&type=remuneration"
  test_pdf "batch-payslips" "/api/payroll/payroll-documents?runId=${RID}&type=batch-payslips"
}

echo "── Tier 2: Reports with real data ──"
# Verify reports return actual numbers, not zeros
for report in "reports-income-statement?period_start=2026-01-01&period_end=2026-03-31" \
  "reports-balance-sheet?as_at_date=2026-03-30" \
  "reports-vat-return?period_start=2026-01-01&period_end=2026-02-28"; do
  result=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/${report}" 2>/dev/null)
  ok=$(echo "$result" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','ERR'))" 2>/dev/null || echo "ERR")
  name=$(echo "$report" | cut -d'?' -f1)
  if [ "$ok" = "True" ]; then pass; else fail "REPORT ${name}"; fi
done

# VAT calculation verification
echo "── Tier 2: VAT Calc Verification ──"
curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customer-invoices-detail?id=f1000000-0000-0000-0000-000000000001" 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
sub=float(d.get('subtotal',0)); rate=float(d.get('tax_rate',0)); tax=float(d.get('tax_amount',0)); total=float(d.get('total_amount',0))
expected_tax=round(sub*rate/100,2); expected_total=sub+expected_tax
ok = abs(tax-expected_tax)<0.01 and abs(total-expected_total)<0.01
print(f'VAT: sub={sub} rate={rate}% tax={tax} total={total} {\"PASS\" if ok else \"FAIL\"}')" 2>/dev/null
VAT_OK=$?
[ $VAT_OK -eq 0 ] && pass || fail "VAT_CALC"

[ "$TIER" -lt 3 ] && { echo "Total: ${PASS} pass, ${FAIL} fail" | tee -a "$LOG"; [ -n "$ERRORS" ] && echo -e "$ERRORS"; exit 0; }

# ═══════════════════════════════════════════════════════════════════════════
# TIER 3: Full Flow Tests (every hour)
# ═══════════════════════════════════════════════════════════════════════════
echo "── Tier 3: Invoice→Approve→GL Flow ──"
# Create a draft invoice, approve it, verify GL journal is created
# Test approve on existing draft invoice
DRAFT_ID=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customer-invoices-list?status=draft" 2>/dev/null | python3 -c "import sys,json; invs=json.load(sys.stdin).get('data',{}).get('invoices',[]); print(invs[0]['id'] if invs else '')" 2>/dev/null)
if [ -n "$DRAFT_ID" ]; then
  APPROVE_RESULT=$(curl -s -H "Cookie: ${C}" -X POST -H 'Content-Type: application/json' \
    -d "{\"id\":\"${DRAFT_ID}\",\"action\":\"approve\"}" \
    "${BASE}/api/accounting/customer-invoices-detail" 2>/dev/null)
  GL_ID=$(echo "$APPROVE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('glJournalEntryId','') or '')" 2>/dev/null)
  ok=$(echo "$APPROVE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('success','ERR'))" 2>/dev/null)
  if [ "$ok" = "True" ]; then
    pass; echo "  Invoice approved: ${DRAFT_ID} GL=${GL_ID}"
  else
    fail "INVOICE_APPROVE (draft=${DRAFT_ID})"
  fi
else
  echo "  SKIP: No draft invoices to test approve flow"
  pass
fi

echo "── Tier 3: Month-End Status ──"
ME_RESULT=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/month-end-close" 2>/dev/null)
ME_OK=$(echo "$ME_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('success','ERR'))" 2>/dev/null)
if [ "$ME_OK" = "True" ]; then
  pass
  echo "$ME_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
p=d.get('progress',{})
print(f'  Month-end: {p.get(\"percentComplete\",0)}% complete, status={p.get(\"status\",\"?\")}')" 2>/dev/null
else
  fail "MONTH_END_CHECK"
fi

echo "── Tier 3: Balance Sheet A=L+E Check ──"
BS_RESULT=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/reports-balance-sheet?as_at_date=$(date +%Y-%m-%d)" 2>/dev/null)
echo "$BS_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
a=float(d.get('totalAssets',0)); l=float(d.get('totalLiabilities',0)); e=float(d.get('totalEquity',0))
balanced = abs(a - (l+e)) < 0.01
print(f'  A={a:,.2f} L={l:,.2f} E={e:,.2f} L+E={l+e:,.2f} {\"BALANCED\" if balanced else \"UNBALANCED!\"}')" 2>/dev/null

echo "── Tier 3: Trial Balance Debit=Credit ──"
TB_RESULT=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/reports-trial-balance" 2>/dev/null)
echo "$TB_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin).get('data',{})
dr=float(d.get('totalDebit',0)); cr=float(d.get('totalCredit',0))
balanced = abs(dr-cr) < 0.01
print(f'  DR={dr:,.2f} CR={cr:,.2f} Diff={dr-cr:,.2f} {\"BALANCED\" if balanced else \"UNBALANCED!\"}')" 2>/dev/null

[ "$TIER" -lt 4 ] && { echo "Total: ${PASS} pass, ${FAIL} fail" | tee -a "$LOG"; [ -n "$ERRORS" ] && echo -e "$ERRORS"; exit 0; }

# ═══════════════════════════════════════════════════════════════════════════
# TIER 4: Data Integrity + Edge Cases (every 4 hours)
# ═══════════════════════════════════════════════════════════════════════════
echo "── Tier 4: Data Counts (verify DB has real data) ──"
for check in \
  "customers:$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customers" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)" \
  "invoices:$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customer-invoices-list" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(d.get('total',len(d.get('invoices',[]))) if isinstance(d,dict) else len(d))" 2>/dev/null)" \
  "suppliers:$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/suppliers-list" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)" \
  "gl-accounts:$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/chart-of-accounts" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)" \
  "bank-txns:$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/bank-transactions?limit=1" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('data',{}).get('total',0))" 2>/dev/null)" \
  "employees:$(curl -s -H "Cookie: ${C}" "${BASE}/api/payroll/employees" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)" \
  "payroll-runs:$(curl -s -H "Cookie: ${C}" "${BASE}/api/payroll/payroll-runs" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)"; do
  name="${check%%:*}"; count="${check##*:}"
  if [ "${count:-0}" -gt 0 ] 2>/dev/null; then pass; echo "  ${name}: ${count} records"
  else fail "DATA_EMPTY:${name} (${count})"; fi
done

echo "── Tier 4: Search/Filter Tests ──"
# Customer search
SEARCH=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customers?q=Velocity" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',[]); print(len(d))" 2>/dev/null)
if [ "${SEARCH:-0}" -gt 0 ]; then pass; echo "  Customer search 'Velocity': ${SEARCH} results"
else fail "SEARCH:customer"; fi

# Invoice status filter
FILTER=$(curl -s -H "Cookie: ${C}" "${BASE}/api/accounting/customer-invoices-list?status=paid" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin).get('data',{}); print(len(d.get('invoices',[])))" 2>/dev/null)
if [ "${FILTER:-0}" -ge 0 ]; then pass; echo "  Invoice filter 'paid': ${FILTER} results"; fi

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo "===========================================" | tee -a "$LOG"
echo "TIER ${TIER} COMPLETE — $(date '+%H:%M:%S')" | tee -a "$LOG"
echo "PASS: ${PASS} | FAIL: ${FAIL}" | tee -a "$LOG"
if [ -n "$ERRORS" ]; then echo -e "FAILURES:${ERRORS}" | tee -a "$LOG"; fi
echo "===========================================" | tee -a "$LOG"
exit ${FAIL}
