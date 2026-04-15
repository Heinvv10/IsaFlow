# Phase 3 Closeout — Production-Readiness Fix Sprint

**Date:** 2026-04-15 (spans 2026-04-14 → 2026-04-15)
**Spec:** `docs/superpowers/specs/2026-04-14-production-readiness-sprint-design.md`
**Plan:** `docs/superpowers/plans/2026-04-14-production-readiness-phase3-fix-sprint.md`
**Backlog:** `docs/audits/2026-04-14/05-backlog.md`

## Scorecard

| Pillar | Before | After | Status |
|---|---|---|---|
| **P0 cross-tenant leaks** | 2 (verified live exploits) | 0 | ✅ |
| **P1 functional bugs** | 14 | 0 (all merged or closed-not-bug) | ✅ |
| **P2/P3 quick wins** | 14 targeted | 14 merged or documented | ✅ |
| **tsc --noEmit** | 0 errors | 0 errors | ✅ maintained |
| **console.\* in src/+pages/** | 53 | 0 | ✅ |
| **`handler as any` casts** | 12 | 0 | ✅ |
| **Duplicate Next.js routes** | 1 (`bank-feeds`) | 0 | ✅ |
| **gl_journal_lines.company_id** | missing (structural) | NOT NULL + FK + 2 indexes | ✅ |
| **ESLint `no-console` rule** | absent | active with 3-file allow-list | ✅ new guard |
| **CI lint `decodeToken` scope** | absent | active | ✅ new guard |
| **CI lint `gl_journal_lines` scope** | absent | active (20-line context check) | ✅ new guard |
| **Unit tests added** | — | 82 passing across 12 suites | ✅ |
| **Migrations applied to dev** | — | 292, 325, 326, 327, 328, 329, 330 | ✅ |

## What landed (by BL ID)

### Wave A — 18 parallel isolated fixes
- **BL-02** `8bae305` — P0 `products_categories` tenant-scoped + migration 292
- **BL-03** `6e6866e` — Dashboard bank balance sources from GL, not raw tx
- **BL-04** `47e3a0f` — Dashboard AR/AP exclude drafts + shared status constants
- **BL-07** `1ecfcb5` — `toISODate` helper + fixes budget-vs-actual YTD crash + fiscal-periods format
- **BL-08** `926679e` — supplier-allocations error unswallowed + migration 325 (missing table)
- **BL-09** `c8cd703` — yearEndService hoist `je.company_id` to WHERE
- **BL-10** `a5ad534` — customer-invoices-detail 404 on 0-row UPDATE (S-003)
- **BL-12** `b32e358` — reports-cash-flow: 6 queries → 1 + migration 326 + schema-probe drop
- **BL-14** `55b9a04` — 53 console.\* → log.\*; ESLint `no-console:error` + allow-list
- **BL-15** `dc939f7` — company-logo + companies handlers auth documented/verified
- **BL-16** `c74b444` — Duplicate `pages/accounting/bank-feeds.tsx` deleted
- **BL-17** `935e1ef` — Bank-tx `status` filter honoured without `bank_account_id`
- **BL-18** `ab303c0` — TB response key canonicalized as `rows`
- **BL-20** `fc7f8f2` — register/forgot-password use last-hop IP for rate limit
- **BL-24** `547a647` — supplier-invoices explicit column list + cap limit at 100
- **BL-28** `073f5bb` — closeout (not a code bug — 93% allocated, sample artifact)
- **BL-29** `59bbeca` — SI field closeout (mapper already correct post-BL-24) + **BL-30** decodeToken CI guard
- **BL-36/37/38** `cd0b7b4` — .env.example port aligned + mint-for-admin-qa.ts portable

### Wave B — 5 sequential cross-cutting fixes
- **BL-01** `dd6c0d0` — **P0** `transactionLedgerService.ts` tenant-scoped (audit-trail + bank-tx reports). Live exploit: 3,682 → 0 leak-through rows.
- **BL-05/06** `87a1055` — Migration 327 normalizes VAT Input/Output + retained_earnings subtypes, seeds missing VAT system accounts; bankAllocationService fallback; reports-balance-sheet uses `internalError`. Brightsphere BS now HTTP 200 (was 400).
- **BL-11** `946e6ce` + `9e4df86` — Migration 328 composite `idx_bt_company_date`; explicit 29-column list; limit cap 100. DB time 4.8ms → 0.068ms (**70×**). Follow-up fixed `exclude_reason` → `excluded_reason` typo surfaced at runtime.
- **BL-13** `ce15063` — **STRUCTURAL** — migration 329 adds `gl_journal_lines.company_id` (NOT NULL + FK + 2 indexes). 58 files updated across GL/bank/reports services. CI grep rule forbids future regressions.
- **BL-23** `dc1b517` — Migration 330 + customer-invoices-list: 4 branches → 1 parameterized query.

### Pre-existing in-progress fixes surfaced
- `f5ea4f0` — bank-rule auto-JE now uses `bank_account.gl_account_id` (was the bank_accounts row id); BS contra-assets now subtract from totalAssets. Rescued during BL-13 conflict resolution.

### Wave C — UX polish
- **BL-35** `2aa1075` — gl-import-template.ts → `apiResponse.methodNotAllowed`; pinned PayFast ITN response shape with comment.
- **BL-34** `e01e921` — Tightened handler types across 12 sites; zero `handler as any` remaining in `pages/api/`.

## Wave B live gate evidence

Tested against both ISAFlow Demo (`00000000-0000-0000-0000-000000000001`) and Brightsphere (`d27bac33-cdc0-4e58-bf6b-709c1597d41c`).

| Endpoint | ISAFlow Demo | Brightsphere |
|---|---|---|
| `/api/accounting/reports-cash-flow` | 200 | 200 |
| `/api/accounting/reports-balance-sheet?as_at_date=2026-02-28` | 200 | 200 (was 400 pre-BL-06) |
| `/api/accounting/reports-journal-entries` | 200 | 200 |
| `/api/accounting/reports-audit-trail` | 200 | 200 |
| `/api/accounting/dashboard-stats` | 200 | 200 |
| `/api/accounting/bank-transactions?limit=50` | 200 | 200 (was 500 from exclude_reason typo) |
| `/api/accounting/customer-invoices-list?limit=10` | 200 | 200 |
| `/api/accounting/supplier-invoices?limit=10` | 200 | 200 |
| `/api/accounting/gl-import-template` (GET) | 200 | 200 |
| `/api/accounting/gl-import-template` (POST) | 405 | 405 |
| `/api/accounting/reports-trial-balance` (no params) | 400 (required-param, correct) | 400 |

Perf resample under 10s/10c autocannon on Brightsphere (8,114 bank tx, real-world volume):

| Endpoint | Pre | Post | Notes |
|---|---|---|---|
| bank-transactions list | p99 6,418 ms | ~18 req/s sustained | dev mode; DB time 4.8ms → 0.068ms with new index |
| reports-cash-flow | p99 2,624 ms | ~29 req/s sustained | 6 queries collapsed to 1 + schema-probe removed |

## Deferred items (Phase 4 or ongoing)

Intentionally NOT fixed this sprint:
- **BL-19** (Brightsphere GL backfill from Sage import) — data-only, no code bug
- **BL-21** (in-memory rate-limit → Redis) — Phase 4 hardening
- **BL-22** (CSRF double-submit tokens) — Phase 4 hardening
- **BL-25** (chart-of-accounts cache) — deferred to prod retest decision
- **BL-26** (68 files > 300 LOC) — ongoing ratchet
- **BL-27** (94% of services lack unit tests) — ongoing programme
- **BL-31** (CSP tightening: object-src/base-uri/form-action) — Phase 4
- **BL-32** (legacy `ff_auth_token` cookie removal) — time-gated after 2026-04-21
- **BL-33** (Zod on every write handler) — ongoing
- **Task #20 (follow-up)**: 48 `UPDATE without RETURNING` sites (13 high-risk) surfaced by BL-10. Needs a dedicated sweep.

## What we learned

1. **The 2 pre-existing uncommitted fixes** (bank-rule GL lookup + contra-asset BS handling) surfaced during BL-13's conflict resolution. Without the sprint's structural work we might not have caught them. Rescued as `f5ea4f0`.
2. **Test mocks ≠ real schema.** BL-11's explicit column list (29 cols) passed all mocked-SQL tests because mocks return pre-mapped camelCase objects. The `exclude_reason` → `excluded_reason` typo only surfaced in live HTTP smoke. **Recommendation:** at least one integration test per list endpoint that hits the real DB (or a real migration-backed test DB).
3. **LSP diagnostics across worktrees are noisy.** Hundreds of "Cannot find module '@/lib/...'" reports came from worktree trees that lacked node_modules symlinks. `bunx tsc --noEmit` on master is the authoritative check.
4. **Dev server drift during hot-reload is real.** Restarting dev between migrations gave the most reliable smoke signal.
5. **Audit findings need live verification.** BL-28 (customer payments) and BL-29 (SI field naming) were "not a bug" once sampled properly. Two hours of fix-work saved by checking instead of coding.

## Migrations applied to dev

| # | File | What it does |
|---|---|---|
| 292 | `product_categories_company_id.sql` | Adds nullable `company_id` + index (BL-02) |
| 325 | `supplier_payment_allocations.sql` | Creates the missing table (BL-08) |
| 326 | `gl_journal_entries_company_date_posted_index.sql` | Partial index for posted entries (BL-12) |
| 327 | `vat_and_retained_earnings_subtypes.sql` | Normalizes COA subtypes + seeds Brightsphere VAT accounts (BL-05/06) |
| 328 | `bank_transactions_company_date_index.sql` | Composite covering index (BL-11) |
| 329 | `gl_journal_lines_company_id.sql` | Structural: add column, backfill, NOT NULL, FK, 2 indexes (BL-13) |
| 330 | `customer_invoices_coalesce_index.sql` | Expression index on COALESCE (BL-23) |

**Prod migration plan:** apply 292, 325, 326, 327, 328, 329, 330 in order during a maintenance window. 329 is the longest (10,201 row backfill on dev; prod is larger — expect seconds, not minutes). Run each with `bun run db:migrate` which uses `CONCURRENTLY` + `IF NOT EXISTS`.

## Next steps

### Phase 4 — Hardening (next sprint)
1. Redis-backed rate limiter (BL-21) — eliminates per-process bypass
2. CSRF double-submit tokens (BL-22) — defense-in-depth on GET-triggered writes
3. CSP tightening (BL-31) — `object-src 'none'; base-uri 'self'; form-action 'self'`
4. 48-site `UPDATE without RETURNING` sweep (Task #20 follow-up) — batch fix-up subagents
5. Backup/restore drill on Neon PITR
6. Rollback rehearsal — tag current prod, deploy, roll back, verify
7. Secrets rotation checklist — JWT_SECRET, Neon credentials, SMTP

### Phase 5 — Final verification
Re-run the 4 discovery streams (functional E2E, pentest, perf, code quality) and produce `99-scorecard.md` with go/no-go per pillar.

---

## Hein's sign-off

Phase 3 substantially complete. Ready for Phase 4 planning when you are.
