# Reporting WS1–WS3 ownership rulings (programme lead, 2026-09-05)

Read by every executor before Task 1. Files not listed under your workstream are not yours; write a request into your report and carry on.

## WS1 (charts + presentation) owns
- `src/components/accounting/charts/**`, `src/components/accounting/present/**`, `src/components/accounting/reportControls/**` (granted)
- `pages/accounting/reports/present/**`, `pages/accounting/reports/executive-dashboard.tsx`
- `pages/accounting/reports/income-statement.tsx`, `pages/accounting/reports/balance-sheet.tsx`, `src/components/accounting/IncomeStatementSections.tsx`, `src/components/accounting/BalanceSheetBody.tsx` (granted: trend/budget/columns wiring, additive)
- `pages/api/accounting/reports/account-trends.ts`, `pages/api/accounting/reports/budget-comparator.ts` (granted, exact names may differ per plan)
- `src/modules/accounting/services/reports/statementRows/**` additive (`applyTrend`, `applyBudgetComparator`), `src/modules/accounting/services/reports/trendRows*.ts` / monthly trend service (new files only)
- `incomeStatementRows.ts` and `balanceSheetRows.ts` routing both row
  adapters' `prior` through the shared `priorComparison` helper in
  `comparators.ts`, instead of each adapter building `prior` inline, was
  raised as ungranted by the final review (2026-09-06) — the literal grant
  above covers `statementRows/**` only additively. Accepted by the
  controller as a small shared edit rather than a duplication risk, and
  reviewed across Task 11's rounds 1–2 and the final review. The grant now
  also covers `priorComparison` computing `variancePct` itself from
  `variance` and `value` (so `budget` and `prior` share one sign
  convention) and applying the zero-base rule (a base of exactly zero keeps
  `variance` but drops `variancePct`, since there is no denominator) —
  both added to the same helper in the CRITICAL 1 fix round.
- `src/lib/apiRoutes.ts`: WS1 registered `reports-income-statement` and
  `reports-pack`, which this doc did not list under WS1. Ruling (final
  review, 2026-09-06): kept as-is — append-only, no collision with another
  WS's entries.

## WS2 (packs + exports) owns
- `src/modules/accounting/services/packs/**`, `src/lib/pdf/**`, `pages/api/accounting/packs/**`, `scripts/pdf/**`, `styles/print.css`
- `pages/accounting/reports/report-packs.tsx` — INCLUDING the integration mounts requested by others, done as WS2's final task: WS1's "Present" button (links to `/accounting/reports/present/[pack]`), WS1's waterfall/trends pack sections (import WS1's chart components by the names in the WS1 plan once WS1 merges; until then leave the placeholders), WS3's `<ShareLinkDialog>` behind a Share button and `<CommentaryBlock mode="internal">` under each section (import by the names in the WS3 plan once WS3 merges).
- `src/lib/auth/withAuth.ts` ONLY for the multi-path print token (adversarial review mandatory)
- `src/modules/accounting/services/afs/pdfExportService.ts`, `afsHtmlRendererService.ts`, `afsHtmlTableRenderer.ts`, `noteGenerators/primaryStatements/incomeStatement.ts` (additive seams only, per the WS2 plan)
- `src/components/accounting/packs/**` (granted)
- `src/modules/accounting/services/reports/statementRows/packMappers.ts` and `src/components/accounting/ManagementPandLRows.tsx` (granted: `toManagementBsRows` move; WS1 does not touch these)

## WS3 (share + commentary + annotations) owns
- `src/modules/accounting/services/share/**`, `src/modules/accounting/services/commentary/**`, `src/modules/accounting/services/annotations/**`
- `pages/api/accounting/share/**`, `pages/api/accounting/commentary/**`, `pages/api/accounting/annotations/**`, `pages/share/**`
- `src/components/accounting/commentary/**`, `src/components/accounting/annotations/**`, `src/components/accounting/share/**`
- `scripts/migrations/sql/610_*.sql`, `611_*.sql` (re-verify the prefix before each migration task and before pushing)
- `StatementRow.note?` / `StatementRowView` note marker: additive only, exact diff in the plan
- `pages/_app.tsx` (granted for ONE additive change: gate `TrackerScript` on `isTrackedPath`, Task 16) and `src/modules/analytics/isTrackedPath.ts`

## Shared, touched by nobody without a lead ruling
`src/components/accounting/statement/StatementGrid.tsx` (WS3's additive `onOpenNote` prop is pre-approved as written in its plan), `src/lib/apiRoutes.ts` (each WS registers ONLY its own routes; append-only), `src/components/accounting/accountingNavConfig.ts` (each WS appends its own entries).

## Cross-WS answers
- Security headers / CSP / auth middleware for `pages/share/**`: WS3 verifies in its own plan (read `middleware.ts` and `next.config.js` headers) and adds the exclusion if needed; report the diff.
- Analytics tracker on `/share/*`: EXCLUDE (third-party-facing page; no path/IP capture). WS3 implements the exclusion in the tracker's path filter and tests it.
- Share links recompute from the live ledger (no snapshot) for now; a nullable JSONB snapshot column is the documented escape hatch.
- Budget variance polarity: the budget column carries the movement (actual − budget) and takes only polarity from `budgetVarianceService`; pinned by test (WS1).
- Presentation route fetches the real income statement (with account codes), not the pack's band totals (WS1).
