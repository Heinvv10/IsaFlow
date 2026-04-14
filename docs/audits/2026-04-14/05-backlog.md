# Production-Readiness Backlog — 2026-04-14

Consolidated from:
- `01-functional-bugs.md` (14 findings: 0 P0 / 6 P1 / 5 P2 / 3 P3)
- `02-security-findings.md` (11 findings: 2 P0 / 2 P1 / 4 P2 / 3 P3)
- `03-perf-findings.md` (11 findings: 0 P0 / 2 P1 / 6 P2 / 3 P3)
- `04-code-quality.md` (8 main + 4 hygiene findings: 1 P0 / 4 P1 / 2 P2 / rest P3)
- `00-preflight.md` (5 incidental findings)

## Executive summary

**Total actionable items: 39 after dedup**
- **P0: 2** (both live cross-tenant data leaks — treat as data-breach disclosure events)
- **P1: 14** (core workflows broken or wrong financial numbers surfaced to users)
- **P2: 13** (meaningful UX / perf / coverage gaps)
- **P3: 10** (polish, hygiene, future-proofing)

### Top 5 risks, in order of severity
1. **BL-01** — `transactionLedgerService` leaks every tenant's journal entries and bank transactions to any authenticated viewer. Verified live. Breach-grade.
2. **BL-02** — `products-categories.ts` leaks every tenant's product categories. Verified via static analysis.
3. **BL-05** — VAT bank allocation is broken for both demo companies (COA subtype mismatch). Accountants cannot process VAT from the bank module.
4. **BL-03 / BL-04** — Dashboard cash, AR, and AP widgets show materially wrong numbers vs. the GL, AR aging, and KPI dashboard.
5. **BL-13** — `gl_journal_lines` has no `company_id` column (structural). Causes one live IDOR (BL-01), and every GL aggregate report pays a Seq-Scan penalty.

### Cross-stream convergences (same root, multiple streams)
| Finding | Streams |
|---|---|
| `gl_journal_lines` missing `company_id` | Security (S-001, S-002) + Perf (P-003, P-011) |
| Bank Txns composite index missing | Perf (P-001 + P-010) |
| Cash-flow: 6 Seq-Scans + empty-catch schema probe | Perf (P-002 + P-009) |
| Duplicate `bank-feeds` route | Preflight #3 + Code quality (Q-007) |
| Dashboard numbers vs. aging reports | Functional (F-002 + F-009) |
| VAT COA subtype | Functional (F-003 + F-011) |

---

## Recommended cut line for Phase 3 fix sprint

**Fix all 16 P0/P1 items + 8 high-ROI P2/P3 quick wins = 24 items this sprint.**
Defer 6 P2/P3 items to Phase 4 Hardening (Redis rate limit, CSRF, CSP tightening, test-coverage sprint budget, Zod adoption, legacy cookie cutover) because they are infrastructure, not bug fixes.
Defer the remaining 9 items as either pure data migrations (Brightsphere GL backfill) or ongoing architectural programmes (68-file LOC reduction, 197-service test coverage).

**Scoring:** `Severity (P0=4..P3=1) × Effort (S=4..XL=1)`. Higher score = better ROI.

---

## Ranked items (sorted by severity, then score)

### ▶ P0 — data breach / core invariant broken

---

#### BL-01 — Cross-tenant leak in `transactionLedgerService` (audit-trail + bank-transactions reports)
- **Source:** S-001
- **Severity:** **P0** | **Effort:** S | **Score:** 16
- **Wave:** B (touches a shared service consumed by 4 endpoints — need one PR that fixes service + adds regression + verifies callers)
- **Fix spec:** In `src/modules/accounting/services/gl/transactionLedgerService.ts`, add `AND je.company_id = ${companyId}::UUID` to both SQL queries at lines 54–63 (`getBankTransactions` opening-balance), 66–78 (`getBankTransactions` period), and 230–245 (`getAuditTrail`). Copy the pattern already correct at lines 150/167 in the sibling `getAccountTransactions`. Do not touch `account_code` filter.
- **Tests:** Add `tests/unit/services/transactionLedgerService.test.ts` with two cases: (a) `getBankTransactions(companyA, …)` never returns rows whose parent `je.company_id !== companyA`; (b) same for `getAuditTrail`. Seed two company IDs in setUp, assert counts.
- **Acceptance:** Re-run the live exploit from S-001 — confirm viewer of company `b5e17198…` now sees only its own 1 JE.
- **Risk if deferred:** Reportable POPIA breach; destroys multi-tenant trust.

---

#### BL-02 — `products-categories.ts` returns every tenant's categories
- **Source:** Q-003
- **Severity:** **P0** | **Effort:** S | **Score:** 16
- **Wave:** A
- **Fix spec:** `pages/api/accounting/products-categories.ts:12` — change `SELECT * FROM product_categories WHERE is_active = true ORDER BY name` to `SELECT * FROM product_categories WHERE company_id = ${companyId}::UUID AND is_active = true ORDER BY name`. Confirm `product_categories.company_id` column exists (it should — check schema).
- **Tests:** Integration test: two companies, 3 categories each; call the endpoint with company A's cookie, assert response length = 3 and every row's `company_id` = A.
- **Acceptance:** Live probe with a viewer token — response contains only that user's company's rows.
- **Risk if deferred:** Data leak. Lower blast radius than BL-01 (categories not finance data) but same class of bug.

---

### ▶ P1 — significant workflow / accuracy / auth issue

---

#### BL-03 — Dashboard bank balance shows raw tx sum, not GL
- **Source:** F-001
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** A
- **Fix spec:** `pages/api/accounting/dashboard-stats.ts:38-46` — replace the `SUM(bank_transactions.amount)` aggregation with a GL-sourced balance: `SELECT SUM(jl.debit - jl.credit) FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id JOIN gl_accounts ga ON ga.id = jl.gl_account_id WHERE je.company_id = $1 AND je.status = 'posted' AND ga.account_subtype = 'bank'`. Keep a fallback for tenants with no GL entries (show `— Unreconciled` not a wrong number).
- **Tests:** Unit test against seeded data: 3 bank tx totalling 1000, 2 posted to GL for 600 → widget returns 600, not 1000.
- **Acceptance:** ISAFlow Demo dashboard shows R 975,880.61 (matches TB), not R 35,210,973.52.

---

#### BL-04 — Dashboard AR/AP totals include drafts; diverge from aging reports
- **Source:** F-002 + F-009 (merged)
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** A
- **Fix spec:** `pages/api/accounting/dashboard-stats.ts:55-59` (AR) and the AP equivalent — change `WHERE status NOT IN ('cancelled', 'paid')` to `WHERE status IN ('sent', 'approved', 'overdue', 'partial')`. Extract shared constants `AR_OPEN_STATUSES` / `AP_OPEN_STATUSES` into a single module so dashboard, AR aging, AP aging, and KPI all reference the same list.
- **Tests:** Unit test — seed 3 invoices (1 draft, 1 approved, 1 paid) → widget returns approved balance only.
- **Acceptance:** Dashboard AR = R 12,920,702.54 (matches aging + KPI). Dashboard AP = R 3,158,750.48 (matches aging + KPI).

---

#### BL-05 — VAT bank allocation broken (COA subtype mismatch on both demos)
- **Source:** F-003 + F-011 (merged)
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** B (touches data + code)
- **Fix spec:** Two parts:
  - **(a) Data migration (all tenants):** Write a migration that, for each company, inspects existing VAT accounts (name LIKE '%VAT Input%', '%VAT Output%', account_code IN standard SA VAT codes e.g. 1140/2120) and sets `account_subtype = 'vat_input'` / `'vat_output'` if currently one of `'tax'`, `'other_current_asset'`, or `'other_current_liability'` AND `is_system_account = true`. For Brightsphere (no matching accounts at all): seed the missing VAT Input/Output system accounts.
  - **(b) Code hardening:** In `bankAllocationService`, if `getSystemAccount('vat_input'|'vat_output')` returns null, fall back to look-up by `account_code IN (...)` and flag a warning in the response so the UI can prompt the user. Do not silently fail.
- **Tests:** Allocation with `vatCode=standard` succeeds on both demo companies and produces correctly-signed journal lines against the mapped accounts.
- **Acceptance:** F-003 repro returns 200 with journal entry on both companies. F-011 VAT return shows non-zero boxes for ISAFlow Demo for the 2025-03 to 2026-02 period.

---

#### BL-06 — Brightsphere Balance Sheet 400 (retained_earnings subtype + swallowed error)
- **Source:** F-004
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** B
- **Fix spec:** Two parts:
  - **(a) Data:** Add to the same migration as BL-05 — if a system account with name LIKE '%Retained%' and `account_type = 'equity'` exists but `account_subtype != 'retained_earnings'`, set it. For Brightsphere's SYS11 "Retained Income": `UPDATE gl_accounts SET account_subtype = 'retained_earnings' WHERE is_system_account = true AND account_type = 'equity' AND (name ILIKE '%retained%' OR name ILIKE '%retained income%') AND company_id = $1`.
  - **(b) Code:** `pages/api/accounting/reports-balance-sheet.ts:35` — stop wrapping service-layer errors as generic 400s. Return `apiResponse.internalError(res, err)` (which preserves the stack in dev and logs to the structured logger). Do the same in `pages/api/accounting/supplier-allocations.ts:72-74` (see BL-08).
- **Tests:** Brightsphere balance sheet renders with asset/liab/equity; the retained_earnings resolver returns the expected account.
- **Acceptance:** `GET /api/accounting/reports-balance-sheet` for Brightsphere returns 200 with populated sections.

---

#### BL-07 — Fiscal period date normalization (Budget vs Actual crash + fiscal-periods API)
- **Source:** F-005 + F-012 (merged — same root cause)
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** In `pages/api/accounting/reports-budget-vs-actual.ts:39-43` and in `pages/api/accounting/fiscal-periods.ts` (response mapping), replace `.toString().split('T')[0]` with `new Date(fy.start_date).toISOString().split('T')[0]`. Extract a helper `toISODate(d: Date | string | null): string | null` in `src/lib/dateUtils.ts`, use it in both places, and grep for other `\.split\('T'\)\[0\]` occurrences and convert them.
- **Tests:** Unit tests for `toISODate` with: JS Date, ISO string, null, undefined; confirm output is `YYYY-MM-DD` or null.
- **Acceptance:** `GET /api/accounting/reports-budget-vs-actual?period=ytd` returns 200. `GET /api/accounting/fiscal-periods` returns ISO-format dates.

---

#### BL-08 — Supplier Allocations 400 (error swallowing)
- **Source:** F-006
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** `pages/api/accounting/supplier-allocations.ts:72-74` — same fix pattern as BL-06: stop swallowing the error, surface the real failure via `apiResponse.internalError`. Once the real error is visible, fix the underlying issue (likely missing `supplier_payment_allocations` table rows in the demo env — check schema + run a diagnostic SELECT in the fix). Ensure GET without `payment_id` / `supplier_id` returns the company-scoped list (capped at 200).
- **Tests:** GET with no params returns 200 and an array; GET with invalid `payment_id` returns 404 or empty array, not 400.
- **Acceptance:** Endpoint returns a list without errors for both demo companies.

---

#### BL-09 — `yearEndService.ts` — move `je.company_id` from JOIN to WHERE clause
- **Source:** S-002
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** `src/modules/accounting/services/gl/yearEndService.ts:122, :138` — move the `AND je.company_id = ${companyId}` from the `LEFT JOIN … ON` clause into the outer `WHERE` clause. Add a comment block: `// gl_journal_lines has no company_id column. All tenant scoping MUST go via gl_journal_entries.company_id. See docs/audits/2026-04-14/02-security-findings.md#S-002.`
- **Tests:** Unit test: year-end close for company A does not see any company B journal lines (positive + negative assertion).
- **Acceptance:** Pattern matches other services; regression test passes.

---

#### BL-10 — `customer-invoices-detail` PUT returns `{updated:true}` for 0-row updates
- **Source:** S-003
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** `pages/api/accounting/customer-invoices-detail.ts:56-69` — capture `UPDATE … RETURNING id` rowcount. If 0, return `apiResponse.notFound(res, 'Invoice', id)`. Apply the same pattern to the sibling POST at line 72 (status-action update). Grep for other `const { rowCount } = await sql\`UPDATE …` patterns that don't check `rowCount` and audit them.
- **Tests:** PUT to a foreign-tenant or nonexistent invoice ID returns 404, not 200.
- **Acceptance:** Replay the S-003 exploit — response is 404, not `{updated:true}`.

---

#### BL-11 — `bank-transactions` list: composite index + explicit column list + cap limit
- **Source:** P-001 + P-010 (merged)
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** B (migration)
- **Fix spec:**
  - **Migration:** `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bt_company_date ON bank_transactions (company_id, transaction_date DESC, amount DESC) INCLUDE (bank_account_id, status, amount);`
  - **Service:** `src/modules/accounting/services/bank/bankTransactionQueryService.ts:86-96` — replace `SELECT bt.*` with an explicit column list of the ~20 fields actually read by `mapTxRow`. Cap max `limit` to 100 (currently 200); put 200 behind `/export` only.
  - **Follow-up:** check whether `idx_bt_date` has any other consumer (`bankReconciliationReport` service) and drop if not.
- **Tests:** Regression: `EXPLAIN` on the list query uses the new composite index. Payload size for `limit=50` drops by ≥30%.
- **Acceptance:** `EXPLAIN ANALYZE` shows `idx_bt_company_date` in use; dev-mode p95 improves.

---

#### BL-12 — `reports-cash-flow`: collapse 6 queries into 1; cache schema probe
- **Source:** P-002 + P-009 (merged)
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** A
- **Fix spec:** `pages/api/accounting/reports-cash-flow.ts`:
  - Delete the schema-probe try/catch at lines 33-40. Either (a) resolve `hasSubtype` once at module load via `information_schema.columns`, or (b) unconditionally assume the column exists (per migration 260+) and delete the fallback branches.
  - Collapse the 6 grouped aggregates over `gl_journal_lines` into a single conditional-aggregation query (SQL shown in `03-perf-findings.md` P-002). Keep the opening-balance query but move it into the main `Promise.all` batch (not serial before it).
  - Add index: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gl_journal_entries_company_date_posted ON gl_journal_entries (company_id, entry_date) WHERE status='posted';` — used by cash-flow, P&L, GL reports.
- **Tests:** Snapshot test — cash-flow response for ISAFlow Demo 2026-01 matches current numbers (no regression in logic).
- **Acceptance:** 6 SQL calls become 1; handler p95 drops materially in prod.

---

#### BL-13 — `gl_journal_lines` add `company_id` column (structural fix)
- **Source:** P-003 + P-011 (perf) + structural from S-001/S-002
- **Severity:** P1 (architectural) | **Effort:** L | **Score:** 6
- **Wave:** B (migration + codemod across 10+ services)
- **Fix spec:** Migration:
  1. `ALTER TABLE gl_journal_lines ADD COLUMN company_id UUID;`
  2. Backfill: `UPDATE gl_journal_lines jl SET company_id = je.company_id FROM gl_journal_entries je WHERE jl.journal_entry_id = je.id;`
  3. `ALTER TABLE gl_journal_lines ALTER COLUMN company_id SET NOT NULL;`
  4. `ALTER TABLE gl_journal_lines ADD CONSTRAINT fk_gl_journal_lines_company FOREIGN KEY (company_id) REFERENCES companies(id);`
  5. `CREATE INDEX CONCURRENTLY idx_gl_jl_company_entry ON gl_journal_lines (company_id, journal_entry_id);`
  - Update all INSERT paths (grep `INTO gl_journal_lines`) to include `company_id` — must pass the parent entry's company.
  - Update all SELECT/JOIN paths to filter `jl.company_id = $1` in addition to `je.company_id = $1` (defense in depth).
  - Add CI grep check: any `FROM gl_journal_lines` / `JOIN gl_journal_lines` must appear within 15 lines of `jl.company_id` OR `je.company_id`. Fail build otherwise.
- **Tests:** Multi-tenant regression over every service that touches `gl_journal_lines` (11 files per security audit).
- **Acceptance:** BL-01 regression stays green after the codemod; all existing reports still produce the same numbers.
- **Risk:** Highest-blast-radius fix in the sprint. Do this in its own branch with careful staging.

---

#### BL-14 — Replace 53 `console.*` calls with `log` from `@/lib/logger`
- **Source:** Q-002
- **Severity:** P1 | **Effort:** M | **Score:** 9
- **Wave:** A (mechanical codemod)
- **Fix spec:** Codemod `console.log|info` → `log.info`, `console.warn` → `log.warn`, `console.error` → `log.error`, `console.debug` → `log.debug`. Allow-list the infrastructure files that genuinely need console as the ultimate fallback: `src/lib/logger.ts`, `src/lib/api-error-handler.ts`, `src/lib/neon.ts`. Add ESLint `no-console` rule with file-level overrides for those 3 files. Fix the `logger.ts` internals to document why it's allowed.
- **Tests:** ESLint passes across the codebase.
- **Acceptance:** `grep -rn 'console\.' src pages | grep -v '^src/lib/\(logger\|api-error-handler\|neon\)' | wc -l` returns 0.

---

#### BL-15 — Verify auth on `company-logo.ts` and `companies.ts` handlers
- **Source:** Q-005
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** Read both files. For each handler, verify it either (a) uses `withCompany(withErrorHandler(...))`, (b) uses `withAuth` with explicit tenant scoping inside, or (c) is public. If neither is documented, wrap in `withCompany(withErrorHandler(...))`. Add a header comment explaining the chosen pattern.
- **Tests:** Live probe: unauthenticated call → 401; cross-tenant call → 403 or scoped response.
- **Acceptance:** Both files have documented auth pattern; probe confirms enforcement.

---

#### BL-16 — Delete duplicate `bank-feeds.tsx` route
- **Source:** Q-007 / Preflight #3
- **Severity:** P1 | **Effort:** S | **Score:** 12
- **Wave:** A
- **Fix spec:** `git rm pages/accounting/bank-feeds.tsx` (the 331-line Stitch-specific variant). Keep `pages/accounting/bank-feeds/index.tsx`. Verify no import references the deleted file (`grep -rn 'bank-feeds\.tsx'`). Confirm the remaining page is linked from `accountingNavConfig.ts`.
- **Tests:** `bun run build` succeeds without the duplicate-page warning.
- **Acceptance:** Next.js startup no longer emits the "Duplicate page detected" warning.

---

### ▶ P2 — meaningful UX / perf / hygiene

---

#### BL-17 — Bank tx `status` filter silently ignored when `bank_account_id` not provided
- **Source:** F-007 | **Sev/Eff/Score:** P2 / S / 8 | **Wave:** A
- **Fix:** `src/modules/accounting/services/bank/bankTransactionQueryService.ts:117-181` — apply the `status` filter in the company-wide branch (lines 175-181) when `filters.status` is truthy. Add unit test: `status='imported'` alone returns only imported txns.

#### BL-18 — Trial Balance API key consistency (`rows` vs `accounts`)
- **Source:** F-008 | **Sev/Eff/Score:** P2 / S / 8 | **Wave:** A
- **Fix:** Pick one canonical key (`rows` — frontend already reads it). Update `TBRow` type and any doc comments in `balanceSheetService` to use `rows`. Grep for external `response.data.accounts` consumers — none expected.

#### BL-19 — Brightsphere has 0 GL journal entries (Sage import didn't post)
- **Source:** F-010 | **Sev/Eff/Score:** P2 / L / 4 | **Wave:** DEFER (data migration, separate effort)
- **Fix:** Not a code bug. Decision: either (a) re-run Sage import with GL posting enabled for Brightsphere, or (b) leave Brightsphere as "opening-balance-only" demo. Recommend (a). Write a separate `tools/migration/sage-post-gl.ts` script, run on dev only. Not in this sprint.
- **Defer rationale:** Pure data work, not source code; blocks Phase 5 re-verification of Brightsphere BS/IS/CF but not of ISAFlow Demo.

#### BL-20 — `register.ts` / `forgot-password.ts` use spoofable first-hop IP for rate limit
- **Source:** S-004 | **Sev/Eff/Score:** P2 / S / 8 | **Wave:** A
- **Fix:** Replace `x-forwarded-for` first-hop with the shared helper from `src/lib/rateLimit.ts:50` (uses last hop, already correct). Fix the doc comment in `register.ts:7-8` that claims "does NOT set an auth cookie" (it does).

#### BL-21 — In-memory rate limiter won't hold under horizontal scaling
- **Source:** S-005 | **Sev/Eff/Score:** P2 / M / 6 | **Wave:** Phase 4 (deferred to hardening)
- **Fix:** Migrate `src/lib/rateLimit.ts` counters to Redis (`src/lib/redis.ts` exists). Keep LRU as local fallback.
- **Defer rationale:** Single-pod deploy today; becomes relevant only with horizontal scaling, which is part of the hardening checklist.

#### BL-22 — No CSRF protection on state-changing endpoints
- **Source:** S-006 | **Sev/Eff/Score:** P2 / M / 6 | **Wave:** Phase 4 (deferred)
- **Fix:** Double-submit-cookie CSRF token on non-idempotent routes OR explicit GET-disables-side-effects rule in `apiResponse`. Today mitigated by `SameSite=lax` + all writes being POST/PUT/DELETE.
- **Defer rationale:** Defense-in-depth. No exploit path today; safer to fold into hardening sweep with header tightening.

#### BL-23 — `customer-invoices-list` has 4 duplicated SQL branches + COALESCE kills index
- **Source:** P-004 | **Sev/Eff/Score:** P2 / M / 6 | **Wave:** B
- **Fix:** Consolidate branches into one parameterized query. Add expression index `CREATE INDEX CONCURRENTLY idx_ci_coalesce_client ON customer_invoices ((COALESCE(client_id, customer_id)));`. Follow-up (separate ticket): finish the `client_id`/`customer_id` column consolidation and drop the COALESCE entirely.

#### BL-24 — `supplier-invoices` list: explicit column list + cap limit
- **Source:** P-005 | **Sev/Eff/Score:** P2 / S / 8 | **Wave:** A
- **Fix:** Same pattern as BL-11. Replace `SELECT si.*` with explicit column list; cap `limit` at 100. Verify `idx_supplier_invoices_active` covers `(company_id) WHERE deleted_at IS NULL`.

#### BL-25 — `chart-of-accounts` p99 spikes to 2s (small payload)
- **Source:** P-007 | **Sev/Eff/Score:** P2 / S / 8 | **Wave:** A (after prod retest)
- **Fix:** First retest in `next build && next start` — most of the latency is dev mode. If p99 still >1s in prod, add in-memory TTL cache (accounts rarely change, 60s TTL).

#### BL-26 — Top 6 files > 500 lines (WizardSteps 674, bank-reconciliation/import 627, etc.)
- **Source:** Q-001 | **Sev/Eff/Score:** P2 / L / 4 | **Wave:** C (polish) / DEFER
- **Fix:** Set lint ratchet at 68 offenders. Split each of the 6 worst into sub-components + custom hooks. Do opportunistically in same PRs that touch those pages; not a dedicated sprint item.
- **Defer rationale:** Mechanical but time-consuming; no functional or security impact.

#### BL-27 — Test coverage: 94% of services have zero tests
- **Source:** Q-008 | **Sev/Eff/Score:** P2 / XL / 2 | **Wave:** Phase 4 (ongoing programme)
- **Fix:** Sprint-level: require tests for any service being modified in this sprint (all waves). Longer-term: per-sprint budget of 5 new service tests for the heaviest untested services (creditNoteService, bankAllocationService, eftService, approvalService, purchaseOrderService — all 280-333 LOC and untested).
- **Defer rationale:** Too large for one sprint; kick off as an ongoing programme in Phase 4.

#### BL-28 — Customer payments `allocatedAmount` always 0
- **Source:** F-013 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A (investigate first)
- **Fix:** Likely data — `customer_payment_allocations` table may be empty. Run diagnostic SELECT; if data missing, backfill from payment-to-invoice links. If code bug, fix the LEFT JOIN / COALESCE.

#### BL-29 — `supplier_invoices.total_amount` null; only camelCase `totalAmount` populated
- **Source:** F-014 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** C
- **Fix:** Pick one canonical serialization (camelCase to match customer_invoices). Remove the null `total_amount` field from the response OR populate both (preferred for backwards-compat, but audit first whether any consumer reads snake_case).

---

### ▶ P3 — polish, hygiene, future-proofing

---

#### BL-30 — Add CI grep check forbidding external `decodeToken` imports
- **Source:** S-007 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A
- **Fix:** Add to CI: `! grep -rn "import.*decodeToken" src/ pages/ | grep -v 'src/lib/auth/jwt.ts'` — fail if any external import.

#### BL-31 — CSP tightening (`object-src`, `base-uri`, `form-action`)
- **Source:** S-008 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** Phase 4
- **Fix:** Add `object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests` to `next.config.js` CSP. Separately migrate inline styles to CSS modules/Tailwind and drop `'unsafe-inline'` from `style-src`.

#### BL-32 — Remove legacy `ff_auth_token` cookie fallback (after cutover window)
- **Source:** S-009 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** DEFER (time gate)
- **Fix:** 14 days after commit `f0cf1d6` (rename) — i.e. after 2026-04-21 (rename was ~2 weeks ago, dates approximate) — delete the `LEGACY_COOKIE_NAME` fallback from `src/lib/auth/sessionHelpers.ts` and `middleware.ts`.

#### BL-33 — Adopt Zod schemas on every write handler
- **Source:** S-010 | **Sev/Eff/Score:** P3 / L / 2 | **Wave:** ongoing programme
- **Fix:** Codemod one handler at a time during normal modifications. Not a dedicated sprint item.

#### BL-34 — Tighten `withCompany<T extends NextApiHandler>` generic; delete 12 `handler as any` casts
- **Source:** Q-004 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** C
- **Fix:** Update the wrapper signature once; delete the casts in the 12 listed call sites (all under `pages/api/accounting/`).

#### BL-35 — Swap `res.status().json()` → `apiResponse.methodNotAllowed()` in 2 handlers
- **Source:** Q-006 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** C
- **Fix:** `pages/api/accounting/gl-import-template.ts:15` → `apiResponse.methodNotAllowed(res, req.method!, ['GET'])`. Leave `payment-gateway-itn.ts:18` with a comment pinning the response shape to PayFast's spec.

#### BL-36 — `.env.local` duplicate `NEXT_PUBLIC_APP_URL`
- **Source:** Preflight #1 / Q-H2 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A (5 min)
- **Fix:** Delete line 21 from `.env.local`. Document in `docs/setup.md` that prod URL goes in `.env.production` or hosting env, never in `.env.local`.

#### BL-37 — Port drift: package.json `dev` runs :3200, `.env.local` says :3101
- **Source:** Preflight #2 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A
- **Fix:** Align. Recommend: `bun run dev` on `:3000` (Next.js default) and set `NEXT_PUBLIC_APP_URL=http://localhost:3000` in `.env.local`. Update `package.json` script `"dev": "next dev"` (drop `-p 3200`). Or pick 3200 and sync the env. Pick one.

#### BL-38 — `scripts/mint-for-admin-qa.ts` hard-coded absolute import + top-level await
- **Source:** Preflight #4-5 / Q-H3 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A
- **Fix:** Change `import { sql } from '/home/hein/Workspace/IsaFlow/src/lib/neon.ts'` → `import { sql } from '../src/lib/neon'`. Wrap the top-level await in an `async function main() { … }; main().catch(…)` so it runs under both `bun run` and `bunx tsx`. Document the required run command.

#### BL-39 — Add file-level allow-list comment to `src/lib/logger.ts` and peers
- **Source:** Q-H4 | **Sev/Eff/Score:** P3 / S / 4 | **Wave:** A (combined with BL-14)
- **Fix:** Add a top-of-file comment in `src/lib/logger.ts`, `src/lib/api-error-handler.ts`, `src/lib/neon.ts` explaining why `console` is allowed here (fallback path when structured logging fails). Covered by BL-14's ESLint allow-list — group into one PR.

---

## Deferred to separate programmes

- **BL-19** (Brightsphere Sage GL backfill) — data migration, separate tooling
- **BL-21** (Redis rate limiter) — Phase 4 hardening
- **BL-22** (CSRF tokens) — Phase 4 hardening
- **BL-26** (68-file LOC reduction) — ongoing
- **BL-27** (service test coverage sprint budget) — ongoing programme
- **BL-31** (CSP tightening) — Phase 4 hardening
- **BL-32** (legacy cookie removal) — time-gated (2026-04-21+)
- **BL-33** (Zod schemas on all write handlers) — ongoing

---

## Sprint scope proposal

**Phase 3 Fix Sprint (recommended cut line):** 30 items
- 2 P0 + 14 P1 = 16 items (all must-fix)
- 6 P2 quick wins (BL-17, BL-18, BL-20, BL-23, BL-24, BL-25) — 5 Wave A + 1 Wave B
- 4 P3 quick wins (BL-28 investigate, BL-29, BL-30, BL-36, BL-37, BL-38, BL-39) — 7 Wave A/C
- 1 deferred under specific gates (BL-19 data-only, tracked but not blocking)

**Wave distribution:**
- **Wave A (parallel, isolated):** 18 items — worktree-per-fix, each ≤3 files, TDD, code review, merge
- **Wave B (sequential, cross-cutting):** 6 items — BL-01, BL-05, BL-06, BL-11, BL-13, BL-23 (migrations + shared services)
- **Wave C (parallel, UX polish):** 4 items — BL-26 (opportunistic), BL-29, BL-34, BL-35

**Phase 4 Hardening (next sprint after Phase 3):**
- BL-21 (Redis rate limiter)
- BL-22 (CSRF)
- BL-31 (CSP tightening)
- BL-27 (start test-coverage budget)
- Plus rollback drill, backup drill, secrets rotation from spec

---

## Hein's decision

**Please approve one of:**

- **(A) Fix all P0 + P1 + proposed P2/P3 quick wins (30 items)** — recommended. Maximum production-readiness ROI this sprint.
- **(B) Fix only P0 + P1 (16 items)** — faster, narrower blast radius.
- **(C) Fix only P0 (2 items)** — emergency patch only.
- **(D) Different cut line** — specify which items move in or out.

Once approved, I'll write the Phase 3 implementation plan (per-wave, with TDD specs and dependencies) and stop again for your review before dispatching any fix agents.
