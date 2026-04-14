# Code Quality Audit — 2026-04-14

## Executive summary

- **Rule-violation count (headline):**
  - Files > 300 lines: **68** (of ~2.1k TS/TSX files; biggest is `WizardSteps.tsx` at 674)
  - Explicit `: any` type annotations: **25 occurrences** across 22 files
  - `as any` casts: **27 occurrences** across 24 files (12 in handler wrappers — see Q-004)
  - `console.log/warn/error/info/debug`: **53 occurrences** across 43 files
  - Empty `catch {}` blocks: **0** (clean)
  - API handlers missing `withCompany`: **7** (5 intentional group/webhook, 2 orphan) see Q-005
  - SQL queries with no `company_id` at all in file: **2 API handlers** + **5 services** (1 CRITICAL: `products-categories.ts`)
  - API handlers using raw `res.json/status` without `apiResponse`: **2** (`payment-gateway-itn.ts`, `gl-import-template.ts`)
- **Architecture smells:** 8 flagged (Q-001 through Q-008)
- **Test coverage:** **197 of 209** services (94%) have **zero** unit tests. Top-level `pages/api/accounting` routes: **0 of 277** have dedicated integration tests.
- **Top 5 refactor priorities:**
  1. **CRITICAL — multi-tenant leak** in `pages/api/accounting/products-categories.ts` (no `company_id` filter — Q-003)
  2. **Kill duplicate route** `pages/accounting/bank-feeds.tsx` (331 lines, superseded by `bank-feeds/index.tsx` — Q-007)
  3. **Refactor `WizardSteps.tsx` (674 LOC)** and next 5 over-limit files (Q-001)
  4. **Remove 53 `console.*` calls** — they leak to prod and break the CLAUDE.md logger rule (Q-002)
  5. **Lift test coverage** — write at least smoke tests for the 12 services over 290 LOC (Q-008)

---

## A. CLAUDE.md rule violations

| Rule | Count | Top offenders |
|---|---:|---|
| Files > 300 lines | 68 | `src/components/onboarding/WizardSteps.tsx` — 674, `pages/accounting/bank-reconciliation/import.tsx` — 627, `src/components/accounting/BankTxTable.tsx` — 614, `src/modules/accounting/services/core/pdfShared.ts` — 597, `pages/accounting/purchase-orders/[poId].tsx` — 551, `pages/admin/companies/index.tsx` — 526, `pages/accounting/bank-reconciliation/rules.tsx` — 507, `pages/accounting/document-capture/[docId].tsx` — 497, `src/components/layout/AppLayout.tsx` — 481, `pages/accounting/bank-reconciliation/[reconId].tsx` — 476, `pages/accounting/bank-accounts/index.tsx` — 459, `pages/payroll/employees/[employeeId].tsx` — 457, `pages/admin/companies/[id].tsx` — 455, `pages/accounting/customers/statement.tsx` — 444, `pages/accounting/sales-reps/index.tsx` — 439 |
| Explicit `: any` | 25 | `pages/accounting/bank-transactions/new.tsx` — 3, `pages/api/accounting/reports-pdf.ts` — 2, 20 other files with 1 each |
| `as any` casts | 27 | `src/modules/accounting/services/reports/customReportRunner.ts` — 2, `pages/api/payroll/irp5-generate.ts` — 2, `src/lib/logger.ts` — 2, 18 other files with 1 each. 12 of these are in handler wrappers (`handler as any`) following the documented Next.js pattern. |
| `console.*` | 53 | `src/lib/api-error-handler.ts` — 3, `src/lib/logger.ts` — 3, `src/modules/accounting/services/reports/customReportRunner.ts` — 2, `pages/api/payroll/irp5-generate.ts` — 2, `pages/api/accounting/reports-pdf.ts` — 2, `pages/api/accounting/eft-generate.ts` — 2, `pages/accounting/bank-transactions/new.tsx` — 3. Full list: `src/modules/accounting/utils/statementPdf.ts`, `…/reconReportPdf.ts`, `src/modules/accounting/services/gl/chartOfAccountsService.ts`, `src/lib/auth/withCompany.ts`, `…/withModulePermission.ts`, `…/withWriteAccess.ts`, `…/middleware.ts`, `src/contexts/CompanyContext.tsx`, `src/lib/neon.ts`, `src/modules/admin/services/userImpersonationService.ts`, `src/modules/accounting/services/core/docExtractionEnhancedService.ts`, `…/sageCustomerImportService.ts`, `…/sageImportService.ts`, `…/recurringTransactionService.ts`, `…/emailService.ts`, `pages/api/accounting/exchange-rate-convert.ts`, `…/approval-requests.ts`, `…/account-reporting-groups/[id]/members.ts`, `…/reports-journal-entries.ts`, `…/bank-feeds/[id].ts`, `…/bank-feeds/[id]/logs.ts`, `…/bank-feeds/index.ts`, `…/bank-feeds/[id]/sync.ts`, `…/migration/sage-pull.ts`, `…/tax-directives.ts`, `…/account-reporting-groups.ts`, `…/customer-invoices-adjacent.ts`, `…/anomaly-scan.ts`, `…/doc-auto-invoice.ts`, `…/bank-accounts.ts`, `…/migration-execute.ts`, `…/reports/customer-communication.ts`, `…/sars/emp501.ts`, `…/ai-categorize.ts`, `pages/accounting/bank-reconciliation/import.tsx`, `pages/admin/tools/migrations.tsx` |
| Empty `catch {}` | 0 | none |
| Handlers missing `withCompany` | 7 (2 problematic) | **Intentional** (group-scoped via `verifyGroupAccess` or public webhook — documented in source): `company-groups.ts`, `company-documents.ts`, `consolidated-reports.ts`, `intercompany-transactions.ts`, `payment-gateway-itn.ts`. **Needs review:** `pages/api/accounting/company-logo.ts`, `pages/api/accounting/companies.ts`. |
| SQL missing `company_id` (CRITICAL if real) | 2 API + 5 services | **API: `pages/api/accounting/products-categories.ts:12`** — `SELECT * FROM product_categories WHERE is_active = true` with no tenant scope — IDOR/data-leak risk. **API: `pages/api/accounting/reports-management-pack.ts`** — false positive (regex matched; file does scope by company_id). **Services (review required):** `src/modules/accounting/services/ar/portalService.ts`, `…/core/sageCustomerImportService.ts`, `…/core/pdfShared.ts`, `…/core/sageImportService.ts`, `…/reports/transactionReportingService.ts` — these likely receive `companyId` from callers; confirm during remediation. |
| Non-`apiResponse` returns | 2 | `pages/api/accounting/payment-gateway-itn.ts:16` (`res.status(405).json(...)` in public webhook — low-impact), `pages/api/accounting/gl-import-template.ts:15` (`res.status(405).json(...)` for method-not-allowed path — should use `apiResponse.methodNotAllowed`) |

---

## B. Architecture smells

### Q-001: Oversized component files violating 300-line rule
- **Severity:** P2
- **Where:** 68 files total; top 5: `src/components/onboarding/WizardSteps.tsx` (674), `pages/accounting/bank-reconciliation/import.tsx` (627), `src/components/accounting/BankTxTable.tsx` (614), `src/modules/accounting/services/core/pdfShared.ts` (597), `pages/accounting/purchase-orders/[poId].tsx` (551)
- **Issue:** Of 68 over-limit files, 6 exceed 500 lines (the "very bad" band). Only 1 service (`pdfShared.ts`) is over 500 — rest are React pages/components where extracting sub-components is straightforward.
- **Refactor cost:** L (full sweep) / S (per file — split into sub-components + custom hooks)
- **Recommended action:** Set a ratchet baseline at 68 and block new offenders in lint. Attack the top 6 (>500) first; each is a mechanical split (table rows, form sections, tab panels).

### Q-002: `console.*` calls leak to production (53 hits, CLAUDE.md violation)
- **Severity:** P1
- **Where:** 43 files (full list above). Notable: `src/lib/logger.ts:3`, `src/lib/api-error-handler.ts:3`, `src/lib/neon.ts:1`, `src/lib/auth/*.ts` (4 files each with 1).
- **Issue:** CLAUDE.md rule is explicit: "No `console.log` - use proper logger." The logger itself and core auth middleware contain console calls — they ship with every request.
- **Refactor cost:** M (most are drop-in replacements with `log.info/warn/error`)
- **Recommended action:** Batch-replace with `log.*`; allow-list the 5 infrastructure files (`logger.ts`, `api-error-handler.ts`, `neon.ts`) that genuinely need a fallback and add ESLint `no-console` rule with file-level exceptions.

### Q-003: CRITICAL multi-tenant leak in products-categories handler
- **Severity:** P0
- **Where:** `pages/api/accounting/products-categories.ts:12`
- **Issue:** `SELECT * FROM product_categories WHERE is_active = true ORDER BY name` — wrapped with `withCompany` (so auth is enforced) but the SQL never uses `companyId`, so every tenant sees every other tenant's product categories.
- **Refactor cost:** S (<15 min)
- **Recommended action:** Add `AND company_id = ${companyId}::UUID` to the WHERE clause; verify `product_categories` has `company_id` column; confirm no callers rely on cross-tenant data.

### Q-004: `handler as any` pattern used 12 times in API wrappers
- **Severity:** P3
- **Where:** `pages/api/accounting/exchange-rate-convert.ts:91`, `…/reports/customer-communication.ts:129`, `…/account-reporting-groups.ts:99`, `…/account-reporting-groups/[id]/members.ts:62`, `…/reports-journal-entries.ts:104`, `…/customer-invoices-adjacent.ts:64`, `…/tax-directives.ts:82`, `…/bank-feeds/index.ts:58`, `…/bank-feeds/[id].ts:28`, `…/bank-feeds/[id]/logs.ts:30`, `…/bank-feeds/[id]/sync.ts:29`
- **Issue:** CLAUDE.md permits `as any` for Next.js handler wrapping, so these are technically compliant — but a single typed wrapper signature would remove them all. Many other handlers in the same directory don't need the cast (they're typed properly), which means the pattern is inconsistent.
- **Refactor cost:** S (fix `withCompany`/`withErrorHandler` signatures once)
- **Recommended action:** Tighten the generic on `withCompany<T extends NextApiHandler>` so handler types flow through; delete the casts.

### Q-005: Ambiguous auth on two handlers (company-logo, companies)
- **Severity:** P1
- **Where:** `pages/api/accounting/company-logo.ts`, `pages/api/accounting/companies.ts`
- **Issue:** Neither uses `withCompany(withErrorHandler(…))` wrapping, and neither has a documented alternative (unlike `consolidated-reports.ts` which explains its `withAuth` usage). They *do* reference `apiResponse` (8 and 14 hits) so they're not trivially broken, but the auth path needs verification.
- **Refactor cost:** S (audit + wrap if appropriate)
- **Recommended action:** Read both files, confirm tenant scoping, convert to `withCompany` or document the exception in a header comment like `consolidated-reports.ts`.

### Q-006: Non-helper responses in two handlers
- **Severity:** P3
- **Where:** `pages/api/accounting/payment-gateway-itn.ts:18`, `pages/api/accounting/gl-import-template.ts:16`
- **Issue:** Both use `res.status(405).json({ error: '...' })` instead of `apiResponse.methodNotAllowed()`. ITN is a webhook so PayFast's contract may require a specific shape — check before changing.
- **Refactor cost:** S
- **Recommended action:** Swap `gl-import-template.ts` to `apiResponse.methodNotAllowed(res, req.method!, ['GET'])`; leave ITN but add a comment pinning the response shape to PayFast's spec.

### Q-007: Duplicate route `/accounting/bank-feeds` — Next.js warning
- **Severity:** P1
- **Where:** `pages/accounting/bank-feeds.tsx` (331 LOC) and `pages/accounting/bank-feeds/index.tsx` (183 LOC)
- **Issue:** Next.js build warns: "Duplicate page detected". Both resolve to `/accounting/bank-feeds`. The **shorter** `/bank-feeds/index.tsx` is the current implementation (Open Banking management); the **larger** `bank-feeds.tsx` is an older Stitch-specific variant. Whichever loses the tie-break silently, users see one and lose the other. Neither uses `apiResponse` (both are client pages), so no DB impact, but UX/routing is broken.
- **Refactor cost:** S
- **Recommended action:** Delete `pages/accounting/bank-feeds.tsx`; it's superseded by the directory version.

### Q-008: Test coverage is effectively zero for services
- **Severity:** P2
- **Where:** `src/modules/accounting/services/**` (209 files), `tests/unit/services/**`
- **Issue:** 197 of 209 service files have no `<name>.test.ts` — only ~12 services tested. No integration tests for any of the 277 top-level API routes. TDD is mandated in CLAUDE.md.
- **Refactor cost:** L (comprehensive coverage is weeks of work)
- **Recommended action:** Establish a per-sprint test-debt budget: require tests for any service being modified + 5 new tests per sprint on the heaviest untested services (creditNoteService, bankAllocationService, eftService, approvalService, purchaseOrderService — all ~280–333 LOC and untested).

---

## C. Test coverage gaps

**Headline:** 197 of 209 services untested. Abbreviated list of high-value untested services (≥250 LOC):

| Service | Lines | Test? |
|---|---:|:-:|
| `src/modules/accounting/services/core/pdfShared.ts` | 597 | ❌ |
| `src/modules/accounting/services/ar/creditNoteService.ts` | 333 | ❌ |
| `src/modules/accounting/services/bank/bankAllocationService.ts` | 301 | ❌ |
| `src/modules/accounting/services/core/companyMapper.ts` | 299 | ❌ |
| `src/modules/accounting/services/ap/eftService.ts` | 296 | ❌ |
| `src/modules/accounting/services/ar/salesOrderService.ts` | 295 | ❌ |
| `src/modules/accounting/services/gl/approvalService.ts` | 294 | ❌ |
| `src/modules/accounting/services/core/archiveQueryService.ts` | 294 | ❌ |
| `src/modules/accounting/services/ar/debtorsManagerService.ts` | 294 | ❌ |
| `src/modules/accounting/services/core/jobQueueService.ts` | 293 | ❌ |
| `src/modules/accounting/services/core/globalSearchService.ts` | 293 | ❌ |
| `src/modules/accounting/services/gl/chartOfAccountsService.ts` | 292 | ❌ |
| `src/modules/accounting/services/reports/reportingEngineService.ts` | 284 | ❌ |
| `src/modules/accounting/services/ap/purchaseOrderService.ts` | 283 | ❌ |
| `src/modules/accounting/services/ar/portalService.ts` | — | ❌ |
| `src/modules/accounting/services/bank/bankRulesMatchingService.ts` | — | ❌ |
| `src/modules/accounting/services/bank/bankImportService.ts` | — | ❌ |
| `src/modules/accounting/services/bank/openBankingConnectionService.ts` | — | ❌ |
| `src/modules/accounting/services/bank/vlmBankService.ts` | — | ❌ |
| `src/modules/accounting/services/bank/bankRulesService.ts` | — | ❌ |

(full list: 197 entries — run `find src/modules/accounting/services -name '*.ts' | while read f; do base=$(basename "$f" .ts); test_file=$(find tests/unit -name "${base}.test.ts" 2>/dev/null | head -1); [ -z "$test_file" ] && echo "$f"; done` to regenerate)

**Integration tests for API routes:** 0 of 277 top-level accounting endpoints have dedicated `tests/e2e` or integration coverage keyed to the handler file.

---

## D. Next.js hygiene

### Q-H1: Duplicate page `bank-feeds`
See Q-007. `pages/accounting/bank-feeds.tsx` is dead; delete it. Next.js docs confirm the file-vs-dir tie-break is undefined behaviour.

### Q-H2: Duplicate `NEXT_PUBLIC_APP_URL` in `.env.local`
- **File:** `.env.local`
- **Values:**
  - `NEXT_PUBLIC_APP_URL=http://localhost:3101`
  - `NEXT_PUBLIC_APP_URL=https://app.isaflow.co.za`
- **Issue:** dotenv/Next.js takes the last occurrence. Developer ends up with the prod URL baked into local dev builds unless they know to delete the second line. This has almost certainly caused at least one confused debug session.
- **Fix:** Delete the second line from `.env.local`; move prod URL to `.env.production` (not committed) or a Vercel env.

### Q-H3: `scripts/mint-for-admin-qa.ts` uses absolute import
- **File:** `scripts/mint-for-admin-qa.ts:2`
- **Code:** `import { sql } from '/home/hein/Workspace/IsaFlow/src/lib/neon.ts';`
- **Issue:** Hard-coded absolute path tied to one developer's machine. The script cannot run on CI, on another dev's box, or on the Velocity server. Also imports with a `.ts` suffix which only works under `bun`/`tsx` — not `node`.
- **Fix:** Change to `import { sql } from '../src/lib/neon';` and document that the script must be run with `bun`.

### Q-H4 (bonus): `logger.ts` itself contains `console.log/error`
- **File:** `src/lib/logger.ts`
- **Issue:** Depending on the logger internals this may be intentional (fallback when structured logging fails) but it undermines the CLAUDE.md "use `log`" message — devs copy patterns from `lib/`.
- **Fix:** Add a top-of-file comment documenting why console is allowed here and audit the other 4 `src/lib/*` hits (`api-error-handler.ts`, `neon.ts`, `auth/*.ts`) under the same principle.
