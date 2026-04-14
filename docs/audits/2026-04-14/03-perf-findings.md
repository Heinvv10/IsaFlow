# Performance Audit — 2026-04-14

## Executive summary

- **Endpoints tested:** 16 (14 on heavy tenant, 1 on light tenant, 1 report requiring fiscal period)
- **Findings:** P0 **0** | P1 **2** | P2 **6** | P3 **3**
- **p95 budget:** < 800 ms for lists, < 2 s for reports (measured in dev mode)
- **Top 3 slow paths (by p99):**
  1. `/api/accounting/bank-transactions?limit=200` — p99 **6,418 ms**, tail to 8,059 ms
  2. `/api/accounting/bank-transactions?limit=50` — p99 **4,305 ms**, tail to 6,413 ms
  3. `/api/accounting/reports-cash-flow` — p99 **2,624 ms**, Seq-Scans `gl_journal_lines` 6× per call

**Note:** Measured in Next.js **dev mode** (hot-reload, unminified, no route cache). Production will be materially faster (conservative estimate: 3–5× better p50, 2× better p95), but relative rankings and DB-level findings hold. Where we ran `EXPLAIN (ANALYZE, BUFFERS)` the actual Postgres execution times were all sub-5 ms — so observed latency is dominated by Next.js handler overhead, JSON serialization, and concurrency serialization at 10 connections.

**Key DB-level issues (hold in prod too):**
1. `gl_journal_lines` is **Seq-Scanned** on every cash-flow / TB / journal-entries-report call (10,197 rows today, will hurt at 100k+).
2. `gl_journal_lines` has **no `company_id` column** — violates the project's multi-tenant rule ("ALWAYS add `company_id` to every DB query"). All tenancy depends on join to `gl_journal_entries`. This blocks partitioning, RLS, and prevents a composite index `(company_id, journal_entry_id)` for partition pruning.
3. `reports-cash-flow` runs a **schema-probe** (`SELECT account_subtype FROM gl_accounts LIMIT 1`) on **every request** — one wasted roundtrip, always.
4. `bank_transactions` has no composite index `(company_id, transaction_date DESC)`; the planner chose `idx_bt_date` (reverse scan, filter by `company_id`, discarded 6,656 rows) instead of `idx_bank_transactions_company`. Fine today, but becomes a seq-scan-equivalent as other tenants grow on the same DB.
5. `reports-balance-sheet?as_at_date=2026-04-14` returns **400 "Failed to generate balance sheet"** on the heavy tenant — service-layer exception wrapped as a 400. Needs investigation (functional bug, not perf).

---

## Endpoint measurements

Tenant: Brightsphere Technologies unless labelled `-demo`. 20 s, 10 concurrent conns.

| Endpoint | p50 | p95 (97.5%) | p99 | Avg | req/s | Total | err% | Severity |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| bank-transactions?limit=200 | 917 | 5,268 | 6,418 | 1,429 | 6.3 | 136 | 0% | **P1** |
| bank-transactions?limit=50 | 859 | 3,500 | 4,305 | 1,179 | 8.2 | 174 | 0% | **P1** |
| reports-cash-flow | 961 | 2,009 | 2,624 | 1,083 | 8.95 | 189 | 0% | **P2** |
| supplier-invoices | 758 | 1,848 | 1,993 | 902 | 10.65 | 223 | 0% | **P2** |
| reports-journal-entries | 751 | 1,390 | 1,753 | 822 | 11.9 | 248 | 0% | **P2** |
| ar-aging | 716 | 1,421 | 1,761 | 779 | 12.5 | 260 | 0% | **P2** |
| customer-invoices-list | 603 | 1,544 | 1,952 | 745 | 13.2 | 274 | 0% | **P2** |
| executive-summary | 554 | 1,181 | 1,310 | 605 | 16.25 | 335 | 0% | **P3** |
| kpi-scorecard | 558 | 1,220 | 1,285 | 602 | 16.36 | 337 | 0% | **P3** |
| ratios | 552 | 1,026 | 1,154 | 594 | 16.55 | 341 | 0% | **P3** |
| ap-aging | 540 | 1,012 | 1,164 | 562 | 17.55 | 361 | 0% | **P3** |
| suppliers-list | 553 | 1,040 | 1,227 | 579 | 16.9 | 348 | 0% | **P3** |
| income-statement | 526 | 901 | 983 | 541 | 18.25 | 375 | 0% | **P3** |
| trial-balance (demo tenant) | 539 | 919 | 982 | 547 | 17.95 | 369 | 0% | **P3** |
| chart-of-accounts | 363 | 1,026 | 2,019 | 428 | 23.1 | 472 | 0% | **P3** |
| customers | 358 | 828 | 1,026 | 396 | 24.95 | 509 | 0% | **P3** |

All latencies in ms. **No 5xx errors observed.**

---

## Findings

### P-001 — `bank-transactions` list has the highest tail latency

- **Severity:** P1 (p99 > 4 s at limit=50, > 6 s at limit=200)
- **Measured:** limit=50 → p50 859, p95 3,500, p99 4,305 ms, 8.2 req/s. limit=200 → p50 917, p95 5,268, p99 6,418, max 8,059.
- **DB execution time (EXPLAIN ANALYZE, limit=50):** **4.8 ms**. So the latency is *not* in SQL — it's in Next.js handler, JSON serialization of 50× ~10 KB rows (5.44 MB in 20 s at limit=50; 14.3 MB at limit=200), and contention across 10 connections on one Node process in dev mode.
- **Evidence (EXPLAIN):**
  ```
  Limit  (cost=7.32..56.70 rows=50) (actual time=4.348..4.715 rows=50)
    Buffers: shared hit=6479
    ->  Incremental Sort  Sort Key: bt.transaction_date DESC, bt.amount DESC
          ->  Index Scan Backward using idx_bt_date on bank_transactions bt
                Filter: (company_id = 'd27bac33-...'::uuid)
                Rows Removed by Filter: 6656
  Execution Time: 4.803 ms
  ```
  - Planner chose `idx_bt_date` (all tenants) and filtered 6,656 rows out of the scan. The dedicated `idx_bank_transactions_company` was not used. For a single-tenant DB this is fine; for the real multi-tenant DB this discard will grow linearly with total `bank_transactions` size.
- **Row mapper also over-fetches:** `TX_SELECT` does `SELECT bt.*` (all columns) plus 4 `LEFT JOIN`s, then `mapTxRow` reads ~35 fields. `bt.*` includes unused columns (e.g. `bank_reference`, `exclude_reason`, `notes`) — average row width is **1,534 bytes**. The rendered UI (`BankTxTable.tsx`) uses ~12 of those fields.
- **Source:** `src/modules/accounting/services/bank/bankTransactionQueryService.ts:86-96, 174-181`
- **Proposed fix:**
  1. Add composite covering index: `CREATE INDEX CONCURRENTLY idx_bt_company_date ON bank_transactions (company_id, transaction_date DESC, amount DESC) INCLUDE (bank_account_id, status, amount);`
  2. Replace `SELECT bt.*` with an explicit column list of the ~20 fields the mapper actually needs. Expect 30–40% payload reduction.
  3. Cap `limit` to **100** for list endpoints (currently 200); UI already paginates. Keep 200 behind `/export` only.
  4. Investigate why p99 is 4–5× p50 at only 10 concurrent connections in dev — likely Next.js dev mode HMR stalls; retest against `next build && next start` to confirm.

### P-002 — `reports-cash-flow` runs 6 grouped scans + a schema probe on every call

- **Severity:** P1 (p95 2.0 s today, guaranteed to get worse with GL growth)
- **Measured:** p50 961, p95 2,009, p99 2,624 ms, 8.95 req/s.
- **Issues found in handler (`pages/api/accounting/reports-cash-flow.ts`):**
  1. **Schema probe every request (lines 33-40):** `SELECT account_subtype FROM gl_accounts LIMIT 1` inside a `try/catch` to feature-detect a column. This column either exists or it doesn't — cache the answer in module scope or (better) rely on the DB migration status. Adds 1 round-trip (~5-10 ms) on every single request.
  2. **Opening-balance query (lines 46-74) runs serially** before the `Promise.all` — it should be inside the parallel batch.
  3. **Six near-identical grouped aggregates over `gl_journal_lines JOIN gl_journal_entries JOIN gl_accounts`** — each one Seq-Scans `gl_journal_lines` (10,197 rows, Buffers: shared hit=157). With larger tenants this scales linearly. They could be **collapsed into ONE query** using conditional aggregation:
     ```sql
     SELECT
       SUM(CASE WHEN ga.account_type='revenue' THEN jl.credit - jl.debit END) AS revenue,
       SUM(CASE WHEN ga.account_type='expense' THEN jl.debit - jl.credit END) AS expense,
       SUM(CASE WHEN ga.account_subtype='receivable' THEN jl.credit - jl.debit END) AS ar_delta,
       SUM(CASE WHEN ga.account_subtype='payable' THEN jl.credit - jl.debit END) AS ap_delta,
       SUM(CASE WHEN ga.account_subtype IN ('fixed_asset','other_asset') THEN jl.credit - jl.debit END) AS investing,
       SUM(CASE WHEN ga.account_type='equity' AND ga.account_subtype<>'retained_earnings' THEN jl.credit - jl.debit END) AS financing
     FROM gl_journal_lines jl
     JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
     JOIN gl_accounts ga ON ga.id = jl.gl_account_id
     WHERE je.status='posted' AND je.company_id=$1 AND je.entry_date BETWEEN $2 AND $3;
     ```
     Collapses 6 queries → 1 query, one Seq Scan instead of six.
- **Evidence (EXPLAIN on one of 6):**
  ```
  Hash Right Join
    ->  Seq Scan on gl_journal_lines jl  (actual time=0.006..1.043 rows=10197)
  ```
  Same plan repeats 6 times (total ~6 × 2 ms = 12 ms SQL). With 1 M lines that becomes 6 × ~200 ms = 1.2 s pure SQL before considering handler overhead.
- **Proposed fix:**
  1. Collapse 6 queries into 1 (as above). Expect 3–5× reduction in DB time.
  2. Cache `hasSubtype` in module scope (resolve once at process start).
  3. Move opening-balance query into the `Promise.all` batch.
  4. Add index: `CREATE INDEX CONCURRENTLY idx_gl_journal_entries_company_date_status ON gl_journal_entries (company_id, entry_date) WHERE status='posted';` — most cash-flow/P&L reports filter on these three.

### P-003 — `reports-journal-entries` seq-scans `gl_journal_lines`

- **Severity:** P2 (p95 1,390 ms; scales linearly with line count)
- **Measured:** p50 751, p95 1,390, p99 1,753 ms, 11.9 req/s.
- **Evidence (EXPLAIN):**
  ```
  HashAggregate  Group Key: je.id
    ->  Hash Right Join  Hash Cond: (jl.journal_entry_id = je.id)
          ->  Seq Scan on gl_journal_lines jl  (rows=10196, Buffers: shared hit=157)
          ->  Index Scan using idx_gl_journal_entries_company  (rows=54)
  Execution Time: 2.133 ms
  ```
  The planner fully scans `gl_journal_lines` to hash-right-join against 54 parent entries. At 1 M lines this becomes the dominant cost.
- **Root cause:** `gl_journal_lines` has no `company_id` column (violates project multi-tenant rule). Without it the planner cannot prune lines by tenant — it must read all lines and match to the tenant's entry IDs.
- **Source:** `pages/api/accounting/reports-journal-entries.ts:51-71`
- **Proposed fix (choose one):**
  1. **Preferred (long-term):** add `company_id` to `gl_journal_lines` (backfill + NOT NULL + FK), then index `(company_id, journal_entry_id)`. Enables partition pruning and RLS, and matches the project's stated multi-tenant rule.
  2. **Tactical:** rewrite the query to pre-filter entries first and then `JOIN LATERAL`:
     ```sql
     WITH je AS (
       SELECT id, entry_number, entry_date, description, source, status
       FROM gl_journal_entries
       WHERE company_id=$1 AND entry_date BETWEEN $2 AND $3
       ORDER BY entry_date DESC LIMIT $4 OFFSET $5
     )
     SELECT je.*, COALESCE(SUM(jl.debit),0) td, COALESCE(SUM(jl.credit),0) tc
     FROM je LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id=je.id
     GROUP BY je.id, je.entry_number, je.entry_date, je.description, je.source, je.status
     ORDER BY je.entry_date DESC;
     ```
     With `idx_gl_jl_entry` this becomes 200 index lookups instead of a seq-scan.

### P-004 — `customer-invoices-list` has duplicated SQL across 4 branches

- **Severity:** P2 (p95 1,544 ms)
- **Measured:** p50 603, p95 1,544, p99 1,952 ms, 13.2 req/s.
- **DB execution time:** **0.22 ms** — again, SQL is not the bottleneck. Latency is handler + serialization.
- **Issue:** `pages/api/accounting/customer-invoices-list.ts` has 4 almost-identical branches (no-filter, status, clientId, searchTerm), totaling 140+ lines of SQL duplication. A single parameterized query with `(${statusArr}::text[] IS NULL OR ci.status = ANY(...))`-style guards would shrink maintenance surface (and let the planner pick one shape).
- **Functional note:** `COALESCE(ci.client_id, ci.customer_id)` is used in `ORDER BY` candidates and `LEFT JOIN` predicate. No index can support `COALESCE(a,b)` without either adding an expression index (`CREATE INDEX ON customer_invoices ((COALESCE(client_id, customer_id)))`) or finishing the column consolidation. The code comment in `CLAUDE.md` flags both columns exist — finish the migration and drop the coalesce.
- **Proposed fix:**
  1. Consolidate branches into one parameterized query.
  2. Add expression index: `CREATE INDEX CONCURRENTLY idx_ci_coalesce_client ON customer_invoices ((COALESCE(client_id, customer_id)));`
  3. Follow up with data migration to drop one of `client_id`/`customer_id`.

### P-005 — `supplier-invoices` list: no pagination limit cap, no composite index

- **Severity:** P2 (p95 1,848 ms)
- **Measured:** p50 758, p95 1,848, p99 1,993 ms, 10.65 req/s.
- **DB execution time:** **0.094 ms**. Latency is serializing 17 rows × ~5 KB × withJoin.
- **Issue:** `supplier_invoices` uses `SELECT si.*` and the service takes `limit` up to 200 without capping relative to payload. `si.*` includes long text columns (e.g. `notes`, `line_items_json` if present).
- **Proposed fix:** explicit column list; cap list `limit` at 100; verify `idx_supplier_invoices_active` covers `(company_id) WHERE deleted_at IS NULL`.

### P-006 — `ar-aging` and `ap-aging` p95 ~1 s for small tenants

- **Severity:** P2 (ar-aging p95 1,421 ms) / P3 (ap-aging p95 1,012 ms)
- **Measured:** ar p50 716 / p95 1,421; ap p50 540 / p95 1,012.
- ar-aging returns 7 entities, ap-aging returns 0 — latency has nothing to do with data volume. This is pure Next.js-dev-mode floor. **Retest in prod.**
- **Proposed action:** defer unless prod retest shows >1 s p95.

### P-007 — `chart-of-accounts` p99 spikes to 2 s for trivial payload

- **Severity:** P3 (p50 363, p99 2,019 ms)
- **Measured:** p50 363, p95 1,026, p99 2,019 ms, 23.1 req/s, 472 total requests.
- Data is tiny (~50 accounts) yet tail is 2 s. Likely dev-mode GC + handler stall.
- **Proposed action:** retest in prod; if p99 remains > 1 s, add in-memory TTL cache (accounts rarely change).

### P-008 — `income-statement` stable at 1 s

- **Severity:** P3 (p95 901 ms) — **within budget** for reports.
- No action needed; listed as baseline.

### P-009 — Schema-probe anti-pattern in `reports-cash-flow`

- **Severity:** P3 (design smell)
- **Issue:** `try { SELECT account_subtype FROM gl_accounts LIMIT 1 } catch {}` on every request to feature-detect a schema column. Wastes a DB round-trip per call, and silently swallows real errors (empty catch). Violates project rule "No empty catch blocks".
- **Proposed fix:** resolve `hasSubtype` once per process via `information_schema.columns` at cold start, or unconditionally assume the column exists (it does, per migration 260+) and remove the fallback branches.
- **Source:** `pages/api/accounting/reports-cash-flow.ts:34-40`

### P-010 — Missing composite index on `bank_transactions (company_id, transaction_date)`

- **Severity:** P2
- **Evidence:** see P-001. Planner chose the cross-tenant `idx_bt_date` and filtered 80% of rows out. With a 100 k-row `bank_transactions` table across multiple tenants this will become the dominant cost.
- **Proposed fix:**
  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bt_company_date
    ON bank_transactions (company_id, transaction_date DESC, amount DESC);
  ```
  Follow-up: drop `idx_bt_date` if it has no other consumer (check `bankReconciliationReport` service).

### P-011 — `gl_journal_lines` lacks `company_id` (multi-tenant rule violation + perf)

- **Severity:** P1 (architectural)
- **Scope:** every report that aggregates by tenant (TB, BS, IS, cash-flow, GL, journal-entries-report) must join `gl_journal_lines → gl_journal_entries` just to know which tenant a line belongs to.
- **Impact today:** 6 Seq Scans per cash-flow call, 1 Seq Scan per GL report. At 1 M rows, multiplicative.
- **Proposed fix (migration):**
  1. `ALTER TABLE gl_journal_lines ADD COLUMN company_id UUID;`
  2. Backfill: `UPDATE gl_journal_lines jl SET company_id = je.company_id FROM gl_journal_entries je WHERE jl.journal_entry_id = je.id;`
  3. `ALTER TABLE gl_journal_lines ALTER COLUMN company_id SET NOT NULL;`
  4. `CREATE INDEX CONCURRENTLY idx_gl_jl_company_entry ON gl_journal_lines (company_id, journal_entry_id);`
  5. Update all service queries to filter `jl.company_id = $1` as well as `je.company_id = $1`.

---

## Broken routes discovered during perf run

These 404'd during endpoint probing and were either renamed or never existed. Route to the functional-audit stream:

| Request path | Result | Notes |
|---|---|---|
| `/api/accounting/customer-invoices` | 404 | Real name is `/api/accounting/customer-invoices-list`. If any client code still hits `/customer-invoices`, it silently returns the Next.js 404 HTML page. |
| `/api/accounting/suppliers` | 404 | Real name is `/api/accounting/suppliers-list`. Same concern. |
| `/api/accounting/dashboard-summary` | 404 | No endpoint of this name exists. Frontend may be relying on `/reports-executive-summary` instead — confirm. |

Also note: **`/api/accounting/reports-balance-sheet?companyId=<Brightsphere>&as_at_date=2026-04-14` returns 400** with message "Failed to generate balance sheet". The handler (`pages/api/accounting/reports-balance-sheet.ts:35`) wraps service-level failures as a generic `badRequest` — swallowing the real error. This is a functional bug (balance sheet broken for Brightsphere) and a reporting bug (wrong HTTP status, lost error detail). Hand to functional stream.

---

## Files relevant to this report

- `/home/hein/Workspace/IsaFlow/scripts/audit-2026-04-14/perf-autocannon.sh` — load-test runner (created for this audit)
- `/home/hein/Workspace/IsaFlow/scripts/audit-2026-04-14/perf-explain.mjs` — EXPLAIN helper (created for this audit)
- `/home/hein/Workspace/IsaFlow/scripts/audit-2026-04-14/results/*.txt` — raw autocannon output per endpoint
- `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/bank/bankTransactionQueryService.ts` — P-001 target
- `/home/hein/Workspace/IsaFlow/pages/api/accounting/reports-cash-flow.ts` — P-002, P-009 target
- `/home/hein/Workspace/IsaFlow/pages/api/accounting/reports-journal-entries.ts` — P-003 target
- `/home/hein/Workspace/IsaFlow/pages/api/accounting/customer-invoices-list.ts` — P-004 target
- `/home/hein/Workspace/IsaFlow/src/modules/accounting/services/ap/supplierInvoiceService.ts` — P-005 target
- `/home/hein/Workspace/IsaFlow/pages/api/accounting/reports-balance-sheet.ts` — broken-routes entry
