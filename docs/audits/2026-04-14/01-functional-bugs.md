# Functional E2E Audit — 2026-04-14

## Executive summary
- **Companies walked:** ISAFlow Demo (Pty) Ltd (`00000000-0000-0000-0000-000000000001`) and Brightsphere Technologies (Pty) Ltd (`d27bac33-cdc0-4e58-bf6b-709c1597d41c`)
- **Findings:** P0 0 | P1 6 | P2 5 | P3 3
- **Top 3 concerns:**
  - Dashboard bank balance widget reads raw `bank_transactions` sum — diverges from the GL by R34.2M for DEMO company (unreconciled data inflates the balance shown to users)
  - Dashboard `arTotal` widget includes draft invoices alongside approved/overdue ones, overstating receivables by ~R5.6M vs the AR Aging report
  - VAT allocation is broken for both companies: COA account subtypes for the VAT Input and VAT Output accounts do not match the values `bankAllocationService` expects (`vat_input` / `vat_output`), so any bank transaction categorised with a VAT code other than `none` returns a hard error

---

## Findings

### F-001: Dashboard bank balance widget uses raw bank-transactions sum, not GL balance
- **Severity:** P1
- **URL:** `/accounting` → Bank Accounts widget → `/api/accounting/dashboard-stats`
- **Company:** ISAFlow Demo (Pty) Ltd
- **Steps:**
  1. Load the dashboard for ISAFlow Demo.
  2. Read the bank balance shown: **R 35,210,973.52**.
  3. Load the Trial Balance (fiscal period Jan 2027): bank account "Bank - Primary" shows debit R1,113,907.81 − credit R138,027.20 = **R975,880.61** net.
- **Expected:** Bank balance widget reflects the General Ledger balance (from journal lines).
- **Actual:** Widget sums all `bank_transactions.amount` values regardless of reconciliation status, yielding a figure ~R34.2M higher than the GL — an unreliable number for any company that has not fully reconciled.
- **Root cause:** `dashboard-stats.ts` lines 38–46 aggregate `bank_transactions` directly rather than querying `gl_journal_lines` for accounts with `account_subtype = 'bank'`. Because bank imports add raw transactions before they are reconciled into journal entries, the sum double-counts entries.

---

### F-002: Dashboard `arTotal` widget includes draft invoices, overstating AR by ~R5.6M
- **Severity:** P1
- **URL:** `/accounting` → AR widget → `/api/accounting/dashboard-stats`
- **Company:** ISAFlow Demo (Pty) Ltd
- **Steps:**
  1. Load dashboard. AR widget shows **R18,528,775.95**.
  2. Load AR Aging report (`/api/accounting/reports-ar-aging`). Total `balance_due` across 205 rows: **R12,920,702.54**.
  3. Load KPI dashboard (`/api/accounting/kpi-dashboard`). Receivables total: **R12,920,702.54**.
- **Expected:** All three figures agree (AR = outstanding invoices: approved + sent + overdue, excluding drafts).
- **Actual:** Dashboard widget is **R5,608,073** higher than both the AR Aging report and the KPI widget. The delta matches the sum of draft-status invoice balances (~R4.5M from first 200 invoices; full dataset ~R5.6M).
- **Root cause:** `dashboard-stats.ts` line 55–59: `WHERE status NOT IN ('cancelled', 'paid')` — draft invoices are included. AR Aging (`reports-ar-aging`) excludes drafts, matching accounting convention that drafts are not yet receivable.

---

### F-003: VAT bank-transaction allocation fails for both companies — COA subtype mismatch
- **Severity:** P1
- **URL:** `/accounting/bank-transactions` → categorise a transaction → select any VAT code other than "No VAT" → Save
- **Company:** Both
- **Steps:**
  1. POST to `/api/accounting/bank-transactions-action` with `action=allocate`, any `contraAccountId`, `vatCode=standard`.
  2. For ISAFlow Demo: error `"System account with subtype 'vat_output' not found for company 00000000-0000-0000-0000-000000000001"`.
  3. For Brightsphere: error `"System account with subtype 'vat_input' not found for company d27bac33-cdc0-4e58-bf6b-709c1597d41c"`.
- **Expected:** VAT journal lines are created against the VAT Input / VAT Output GL accounts.
- **Actual:** Both companies' VAT GL accounts exist but carry the wrong `account_subtype`:
  - DEMO: account "VAT Input" (1140) has `account_subtype = 'other_current_asset'`; "VAT Output" (2120) has `account_subtype = 'tax'`. `bankAllocationService` calls `getSystemAccount('vat_input' | 'vat_output', ...)` which reads `is_system_account = true AND account_subtype = <key>` — neither account matches.
  - BRIGHT: no accounts with `account_subtype` of `vat_input` or `vat_output` exist at all.
- **Effect:** Users cannot use VAT codes when categorising bank transactions; they must select "No VAT" for every transaction, making VAT return reporting impossible from bank data.

---

### F-004: Brightsphere Balance Sheet endpoint always returns 400
- **Severity:** P1
- **URL:** `/accounting/reports` → Balance Sheet → `/api/accounting/reports-balance-sheet?as_at_date=2026-02-28`
- **Company:** Brightsphere Technologies
- **Steps:**
  1. Request the Balance Sheet for Brightsphere with any `as_at_date`.
  2. Response: HTTP 400 `{"code":"BAD_REQUEST","message":"Failed to generate balance sheet"}`.
- **Expected:** Balance sheet renders with asset, liability, and equity sections.
- **Actual:** Service throws inside `fetchBalanceSheetData` → `getSystemAccount('retained_earnings', companyId)` fails because Brightsphere's retained earnings system account (SYS11 "Retained Income") has `account_subtype = 'equity'` instead of `'retained_earnings'`. The system account resolver cannot locate it, throws an error, and the API catches and swallows it as a generic 400.
- **Note:** ISAFlow Demo has account 3200 "Retained Earnings" with `account_subtype = 'retained_earnings'`, so its Balance Sheet works correctly.

---

### F-005: Budget vs Actual report crashes with SQL date-parse error for `period=ytd` (default)
- **Severity:** P1
- **URL:** `/accounting/budgets` → Budget vs Actual → `/api/accounting/reports-budget-vs-actual`
- **Company:** ISAFlow Demo (Pty) Ltd (any company with fiscal periods)
- **Steps:**
  1. GET `/api/accounting/reports-budget-vs-actual` (no params, defaults to `period=ytd`).
  2. Service queries `fiscal_periods` for start/end dates.
  3. Response: HTTP 500 `{"code":"DATABASE_ERROR","message":"Failed to generate budget vs actual report","details":{"originalMessage":"invalid input syntax for type date: \"Fri Jan 01 2027 00:00:00 GM\""}}`.
- **Expected:** Report loads using the active fiscal year date range.
- **Actual:** Neon returns `Date` objects for date columns; `.toString()` yields `"Fri Jan 01 2027 00:00:00 GMT+0200 (South Africa Standard Time)"`. The code calls `.split('T')[0]` expecting ISO 8601 format (`2027-01-01T00:00:00.000Z`) but the JavaScript Date string has no `T` character before the time part, so `split('T')` returns the entire string, which Postgres rejects.
- **Workaround:** Passing `period=current` works (it uses `new Date()` directly). Only `ytd` / `full_year` are broken.
- **Root cause:** `reports-budget-vs-actual.ts` lines 39–43: `fy?.start_date?.toString().split('T')[0]` — must use `new Date(fy.start_date).toISOString().split('T')[0]` instead.

---

### F-006: Supplier Allocations GET endpoint always returns 400 (without required params)
- **Severity:** P1
- **URL:** `/accounting/supplier-allocations` → `/api/accounting/supplier-allocations` (no `payment_id` or `supplier_id`)
- **Company:** Both
- **Steps:**
  1. GET `/api/accounting/supplier-allocations` (no query params, to list all allocations).
  2. Response: HTTP 400 `{"code":"BAD_REQUEST","message":"Failed to get allocations"}`.
- **Expected:** Returns list of all supplier payment allocations for the company (limited to 200).
- **Actual:** The catch block at line 72–74 of `supplier-allocations.ts` swallows the actual error (likely a DB join failure or missing table) and returns a generic 400. The query joins `supplier_payment_allocations → supplier_payments → supplier_invoices → suppliers` — the error is hidden.
- **Note:** The underlying SQL query is structurally correct; the issue is likely a missing `supplier_payment_allocations` table or FK constraint failure in the demo environment.

---

### F-007: Bank Transaction `status` filter silently ignored when `bank_account_id` is not provided
- **Severity:** P2
- **URL:** `/api/accounting/bank-transactions?status=imported` (without `bank_account_id`)
- **Company:** Both
- **Steps:**
  1. GET `/api/accounting/bank-transactions?status=imported` — returns total 877 with status=matched transactions.
  2. GET `/api/accounting/bank-transactions?status=categorized` — also returns total 877 with status=matched transactions.
  3. GET `/api/accounting/bank-transactions?bank_account_id=<id>&status=imported` — correctly returns 777 (the real imported count).
- **Expected:** Status filter applies regardless of whether `bank_account_id` is provided.
- **Actual:** In `bankTransactionQueryService.ts` lines 117–181: the code path for status filtering only activates when `filters?.bankAccountId && filters?.status` are both truthy. Without `bankAccountId`, it falls to the company-wide query (lines 175–181) which ignores status entirely.
- **Impact:** Any API consumer or automation that filters by status without specifying a bank account receives unfiltered results silently.

---

### F-008: Trial Balance API response uses `rows` key but frontend reads `accounts`
- **Severity:** P2
- **URL:** `/api/accounting/reports-trial-balance` response shape
- **Company:** ISAFlow Demo
- **Steps:**
  1. GET `/api/accounting/reports-trial-balance?fiscal_period_id=<id>`.
  2. Response `data` contains `{ rows: [...], totalDebit: ..., totalCredit: ... }`.
  3. Frontend `pages/accounting/trial-balance/index.tsx` line 70: `setRows(data.rows || [])` — correctly reads `rows`.
  4. However, API documentation comment and the `TBRow` type in `balanceSheetService` reference `accounts`. Any external consumer or alternate frontend code using `data.accounts` gets an empty array.
- **Expected:** Response key and documentation align. A consistent key name is used.
- **Actual:** API returns `rows`, internal types say `accounts`, totals (`totalDebit`, `totalCredit`) are correct. Not a UI bug today (frontend reads `rows`) but is an API contract inconsistency.

---

### F-009: Dashboard `arTotal` and `apTotal` naming conflict with the corresponding aging reports
- **Severity:** P2
- **URL:** Dashboard vs AR/AP Aging reports
- **Company:** ISAFlow Demo
- **Steps:**
  1. Dashboard `arTotal` = R18,528,775.95 (includes drafts).
  2. AR Aging report total `balance_due` = R12,920,702.54 (excludes drafts).
  3. KPI dashboard `receivables.total` = R12,920,702.54 (excludes drafts).
  4. Dashboard `apTotal` = R5,143,323.24.
  5. AP Aging report total `balance_due` = R3,158,750.48.
  6. KPI dashboard `payables.total` = R3,158,750.48.
- **Expected:** The dashboard overview widgets show values consistent with the detailed aging reports.
- **Actual:** Dashboard uses a different SQL query (includes draft invoices for AR; includes different SI statuses for AP) compared to the aging and KPI services. A user comparing the dashboard to the AR Aging report will see irreconcilable differences.

---

### F-010: Brightsphere has zero journal entries — Revenue, Balance Sheet, Income Statement all empty
- **Severity:** P2
- **URL:** `/accounting/reports` — all financial reports for Brightsphere
- **Company:** Brightsphere Technologies
- **Steps:**
  1. GET `/api/accounting/journal-entries` for Brightsphere: `total: 0`.
  2. Income Statement for Brightsphere: `revenue: [], costOfSales: [], operatingExpenses: []`.
  3. Balance Sheet for Brightsphere: fails (F-004 above).
  4. KPI: `revenue.total: 0`, `expenses.total: 0`.
  5. Brightsphere has 8,114 bank transactions and 132 customer invoices, none with posted journals.
- **Expected:** Imported Sage data should have generated opening balance journal entries.
- **Actual:** No GL journal entries exist for Brightsphere. All bank transaction imports, supplier and customer invoices exist but have not been converted into GL postings. This means any P&L or Balance Sheet report for Brightsphere shows nothing (or errors), making the company's financial reports entirely unusable.
- **Note:** This is likely a data setup issue rather than a code bug — the Sage migration populated transaction tables but did not run the GL journal generation step.

---

### F-011: VAT Return all boxes show zero for ISAFlow Demo (2025-03-01 to 2026-02-28)
- **Severity:** P2
- **URL:** `/accounting/reports` → VAT Return → `/api/accounting/reports-vat-return`
- **Company:** ISAFlow Demo
- **Steps:**
  1. GET `/api/accounting/reports-vat-return?period_start=2025-03-01&period_end=2026-02-28`.
  2. All output boxes (1, 1A, 2, 2A, 3, 12) show `amount: 0, transactions: []`.
  3. `totalOutputTax: 0`, `totalInputTax: 0`, `vatPayable: null`.
- **Expected:** VAT return boxes reflect invoiced VAT amounts for the period.
- **Actual:** Zero across all boxes. This is consistent with the fact that the COA has no accounts with `account_subtype = 'vat_input'` or `'vat_output'`, meaning VAT journal lines were never correctly mapped. The VAT return service reads from journal lines tagged to VAT accounts which do not exist with the correct subtypes.

---

### F-012: Fiscal Periods API returns JavaScript Date `.toString()` format for date fields
- **Severity:** P3
- **URL:** `/api/accounting/fiscal-periods`
- **Company:** ISAFlow Demo
- **Steps:**
  1. GET `/api/accounting/fiscal-periods?limit=3`.
  2. `startDate` field value: `"Fri Jan 01 2027 00:00:00 GMT+0200 (South Africa Standard Time)"` (JS Date string).
- **Expected:** ISO 8601 format `"2027-01-01"` or `"2027-01-01T00:00:00.000Z"`.
- **Actual:** Neon returns `Date` objects which are serialised via `JSON.stringify` using `.toISOString()` for true Date fields, but this field appears to reach the serialiser as the `.toString()` representation. Any downstream code that calls `.split('T')[0]` on this value to extract the date portion will receive the full string instead (as seen in F-005).
- **Note:** The `budget-vs-actual` service is already affected (F-005). Other consumers of `fiscal_periods.start_date`/`end_date` may be silently broken.

---

### F-013: `customer-payments` endpoint returns `allocatedAmount: 0` for all 384 confirmed payments
- **Severity:** P3
- **URL:** `/api/accounting/customer-payments`
- **Company:** ISAFlow Demo
- **Steps:**
  1. GET `/api/accounting/customer-payments?limit=10`.
  2. All returned payments show `allocatedAmount: 0` despite `status: confirmed` and `totalAmount > 0`.
- **Expected:** Payments with confirmed status that have been allocated to invoices show a non-zero `allocatedAmount`.
- **Actual:** `allocatedAmount: 0` for all payments checked. Either the `customer_payment_allocations` table has no rows for these payments (data issue), or the left-join in the payments query calculates `COALESCE(SUM(allocated), 0)` before allocations have been applied.
- **Note:** This may be a data issue specific to the demo dataset rather than a code bug — needs further investigation by checking the `customer_payment_allocations` table directly.

---

### F-014: `supplier-invoices` list returns `total_amount: null` (field name mismatch)
- **Severity:** P3
- **URL:** `/api/accounting/supplier-invoices`
- **Company:** Both
- **Steps:**
  1. GET `/api/accounting/supplier-invoices?limit=3`.
  2. Each invoice object contains `totalAmount: 18528.94` (camelCase) but `total_amount: null` (snake_case).
- **Expected:** Both field names exist (for frontend and API consumers respectively) OR only one canonical name is used.
- **Actual:** The API serialises to camelCase (`totalAmount`) but the field `total_amount` is null. If any UI component or export pipeline reads `invoice.total_amount` it will get `null`. Customer invoices return `total_amount` (snake_case) correctly, creating an inconsistency between CI and SI list APIs.

---

## Environment notes

### Company-switching mechanism
The API resolves company context from the `X-Company-Id` request header, **not** from the `company_id` query parameter. The frontend sets this header via `CompanyContext`. Direct API calls without this header fall back to the user's default company (Brightsphere for the admin user).

### System accounts dependency
Many financial workflows (bank allocation with VAT, balance sheet, income statement, VAT return) depend on `gl_accounts` rows having specific `account_subtype` values (`vat_input`, `vat_output`, `retained_earnings`, `bank`, `receivable`, `payable`). Both demo companies have misconfigured subtypes for their VAT accounts, blocking VAT processing entirely.

### Brightsphere GL state
Brightsphere has 0 journal entries. All financial reports that query `gl_journal_lines` return empty results. The balance sheet fails outright (F-004). This company's GL is essentially empty despite having transaction and invoice data.

---

## Summary table

| Finding | Severity | Area | Company |
|---------|----------|------|---------|
| F-001: Dashboard bank balance uses raw TX not GL | P1 | Dashboard | Demo |
| F-002: Dashboard arTotal includes draft invoices | P1 | Dashboard | Demo |
| F-003: VAT bank allocation blocked — COA subtype mismatch | P1 | Bank TX / COA | Both |
| F-004: Brightsphere Balance Sheet always 400 | P1 | Reports | Brightsphere |
| F-005: Budget vs Actual crashes (ytd/full_year) | P1 | Reports | Demo |
| F-006: Supplier Allocations GET returns 400 | P1 | Allocations | Both |
| F-007: Bank TX status filter silently ignored without bankAccountId | P2 | Bank TX | Both |
| F-008: Trial Balance API key `rows` inconsistency | P2 | Reports | Demo |
| F-009: Dashboard AR/AP totals inconsistent with aging reports | P2 | Dashboard | Demo |
| F-010: Brightsphere has zero GL journal entries | P2 | GL / Data | Brightsphere |
| F-011: VAT Return all zeros | P2 | Reports | Demo |
| F-012: Fiscal Periods date fields in JS toString format | P3 | API | Demo |
| F-013: Customer payments allocatedAmount always 0 | P3 | Payments | Demo |
| F-014: Supplier invoices total_amount null (field name mismatch) | P3 | Invoices | Both |

**Summary:** 14 findings — P0 0 | P1 6 | P2 5 | P3 3
