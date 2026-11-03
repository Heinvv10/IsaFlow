# P5 census (T1 + T2), read-only

**Tree:** `/home/hein/Workspace/IsaFlow-p5`, branch `feat/budgets-p5-1-controls-schema-20261102` = `origin/master` `1e924bec1`.
**Method:** `git grep` / file reads only. No database was touched, so nothing below is a runtime measurement.
Where a claim is inference rather than a read, it says so.
**Migration head on this tree:** `949_budget_drivers.sql` (948 is unused). The P5 migration takes the next free prefix at commit time (≥ 950).

---

## Findings that change the spec

1. **§1's "bypass to close" is stale.** `postSupplierInvoiceToGL` no longer posts a draft. Since R-118 it refuses
   any bill outside the AP population (draft, pending_approval, cancelled): `supplierInvoiceWorkflowService.ts:231-236`,
   `shared/documentPopulation.ts:55`. So "post, then approve" cannot happen any more. `postToGLInner` now posts a NEW
   journal only for a bill that is **already approved with no journal**. In practice those are the capture
   auto-approvals (`ai-invoice-pipeline.ts:203`, `capture/[id]/post.ts:228`/`:192`; both INSERT `status='approved'` and
   never call `approveSupplierInvoice`) and approved imports. **The real uncovered approval is the capture
   auto-approval.** A check in `postToGLInner` is the only place that catches it. A refusal there is already handled:
   `provisionalAttachSettle.ts:60-81` withdraws the bill to draft with a note unless the error is contention.
2. **The reused-journal branch** (`approveInner`, `:101-112`) still exists. It runs before the provisional claim and
   before any line/dimension check. It UPDATEs the status only. It is reachable only by a legacy draft that already
   carries a journal, because R-118 stops new ones. That journal is posted, so its amount is **already in actuals**.
   Recommendation: **skip the check** on this branch and record an event `pass` with a note, rather than subtract the
   amount. Refusing it in block mode would leave a posted journal under a draft bill, which is the drift R-118 closed.
   No new spend reaches the GL here.
3. **"Ex-VAT line amount" is not a stored column you can trust.** `supplier_invoice_items.line_total` is
   qty × unit_price (ex-VAT) on REST create (`supplierInvoiceTotals.ts:64`). But `buildExpenseLines` treats line totals
   as **gross** when Σ`line_total` ≈ `total_amount` and scales them, and the last line absorbs the rounding residual to
   `subtotal` (`supplierInvoiceExpenseLines.ts:23-41`). A NULL `gl_account_id` posts to `default_expense` (`:32`).
   `placeCostCentres` then places the legacy `cost_center_id` pick into cc1/cc2 (`supplierInvoiceWorkflowService.ts:122`),
   so **posted dims ≠ stored item dims** whenever a legacy pick exists. The check must therefore key on the lines approve
   will post: `placeCostCentres(buildExpenseLines(invoice, defaultExpense))`. Keying on `supplier_invoice_items` would
   get some bills wrong.
4. **A refusal that throws inside approve is rolled back with everything else.** Every caller runs approve inside a
   savepoint: approve's own (`:50`, `:184`), the bulk item's (`supplier-invoices-bulk-action.ts:126`), the MCP element's
   (`bulkApprovePost.ts:76`) and the MCP registry's. A `refused` `budget_check_events` row written inside approve before
   the throw is therefore lost. The event has to be written after the savepoint rolls back, by whichever layer catches
   the refusal: the action route, the bulk route's catch, the MCP tool. Alternatively the refusal can be returned rather
   than thrown.
5. **The MCP bulk tool unwinds the whole batch on an unknown error** (`bulkApprovePost.ts:139`). `BUDGET_EXCEEDED`
   must be added to `racedReason` (`writeBulkApproveSupplierInvoices.ts:77-84`), or to an equivalent skip path. If it is
   not, "item fails, batch continues" (§3b) is false for MCP: one over-budget bill rolls back up to 100 postings.
6. **A per-item budget lock in the bulk paths deadlocks.** By item k, the bulk route already holds item 1..k-1's
   journal-number key `(company:year, 857)`, taken in the `gl_journal_entries` INSERT trigger
   (`858_document_number_advisory_locks.sql:163`). If approve takes `budget_check:<co>` per item, the order is
   857 → budget. A single approve holding budget then waits on 857 at its INSERT: a deadlock. There is a second reason
   per-item fails: a lock taken inside a savepoint that is rolled back is released (857 header, lines 24-25). So the
   bulk route and the MCP bulk tool **must** take the lock once, before the loop and outside any per-item savepoint.
7. **POs barely carry an account.** `POST /api/accounting/purchase-orders` inserts `po_items` **without
   `gl_account_id`** (`purchase-orders.ts:70`). It also writes `taxRate || 15`, which turns a 0% rate into 15%. Only the
   PUT writes an account (`purchase-orders/[id].ts:203-215`). A PO that was never edited has no account, so its
   commitment cannot be keyed to a budget line. Also: `supplier_invoice_items.po_item_id` has **no FK**
   (`201_accounts_payable.sql:65`), and only the REST `createSupplierInvoice` writes it (`supplierInvoiceService.ts:148`).
   Capture, recurring and MCP bills never link to PO lines, so committed is netted only by REST-created bills.
8. **Defects found during the census, not P5 scope** (report them, don't fix them here):
   - (a) `bank-match-confirm.ts:186` writes `purchase_orders.status = 'paid'`. 246b's CHECK has no `'paid'`, and no
     later migration widens it; `bankMatchDbQueries.ts:172` confirms the allowed set. I infer this is a 23514 after the
     allocation journal has posted; not run.
   - (b) `performThreeWayMatch` selects `po_items … AND company_id = …` and `grn_items … AND company_id = …`
     (`supplierInvoiceWorkflowService.ts:407-415`). Neither table has `company_id` (246b), so I infer a 42703; not run.
   - (c) The PO PUT accepts any CHECK status from a draft/submitted PO. That includes `received` and `cancelled`, not
     only `approved` (`[id].ts:174`).
9. **The cron and RLS (low confidence).** Out-of-request cron code runs on the service pool (`isaflow_service`, which
   inherits `app_service`, has no BYPASSRLS and no JWT claims; see `src/lib/neon.claude.md:36`). `app_service` sees rows
   through the `USING (true)` policies that `app_service_sync_policies()` creates (`915`). 945 and 946 call it; 944, 947
   and 949 do not (git grep). I did not establish whether a deploy step syncs it. T3 must make the new P5 tables
   readable by the cron, and T9 should prove that the cron sees `budget_month_amounts` rows.

---

## T1.1 Callers of `approveSupplierInvoice` / `postSupplierInvoiceToGL` / `approveInner` / `postToGLInner`

Command (non-test TS, comments excluded):
```
git grep -n -E '\b(approveSupplierInvoice|postSupplierInvoiceToGL|approveInner|postToGLInner)\(' -- '*.ts' '*.tsx' ':!tests' ':!*.md' | grep -v -E ':\s*(//|\*)'
```
That gives **8 external call sites**: 6 approve (one is a dev script) and 2 post-to-GL. It also gives 2 internal
`withSavepoint` → inner calls and the 4 definitions. 73 test files mention the two names; they are not listed here.

| # | file:line | function | what it does |
|---|---|---|---|
| 1 | `pages/api/accounting/supplier-invoices-action.ts:60` | approve | UI single approve, `allowLateInputClaim: true`. Imported via the barrel `ap/supplierInvoiceService.ts:184` (re-export) |
| 2 | `pages/api/accounting/supplier-invoices-bulk-action.ts:129` | approve | bulk `approve`, ids sorted (`:117`), one savepoint per id (`:126`), ≤200 ids |
| 3 | `pages/api/accounting/supplier-invoices-bulk-action.ts:134` | postToGL | bulk `post_gl`, same loop |
| 4 | `src/lib/mcp/tools/writeSupplierInvoices.ts:191` | approve | MCP `approve_supplier_invoice`; pre-reads with no lock (`:171-182`) |
| 5 | `src/lib/mcp/tools/writeBulkApproveSupplierInvoices.ts:112` | approve | MCP `bulk_approve_supplier_invoices` `postOne`, run by `bulkApprovePost.ts:71-79` (sorted `:225-229`, savepoint per element) |
| 6 | `src/modules/accounting/services/capture/provisionalAttachSettle.ts:59` | postToGL | after a capture route INSERTs an **auto-approved** bill; reached from `pages/api/accounting/ai-invoice-pipeline.ts:262` and `capture/capturePostFollowUps.ts:86` ← `pages/api/accounting/capture/[id]/post.ts:255` |
| 7 | `src/modules/accounting/services/core/recurringTransactionInvoices.ts:226` | approve | recurring AP template with `autoPost`, after INSERT; route `pages/api/accounting/recurring-transactions-execute.ts:30` → `executeRecurring` (`recurringTransactionService.ts:228`) |
| 8 | `scripts/sandbox/reviewerSandboxBooks.ts:123` | approve | dev reviewer-sandbox seeding script, not a production path |
| — | `supplierInvoiceWorkflowService.ts:50` / `:184` | inner | `approveInner` / `postToGLInner`: one caller each (their public wrapper) |

Approvals that do **not** go through `approveSupplierInvoice`. They write `status='approved'` directly, so a check there
never sees them:
- capture `ai-invoice-pipeline.ts:203` and `capture/[id]/post.ts:228` (status from `:192`): these then reach row 6.
- AP take-on `migrationApService.ts:194`: opening-balance journal, no expense, so out of budget scope.
- Sage `admin/services/sageMigrationCommitService.ts:279`: historical.
- `core/sageSupplierInvoiceImportService.ts:142`.

## T1.2 `purchase_orders.status` writers; `approved_by` / `approved_at` readers

```
git grep -n -E "(UPDATE|INSERT INTO)\s+purchase_orders\b" -- 'src/**' 'pages/**' 'scripts/**.ts'   → 4
```
| file:line | writer |
|---|---|
| `pages/api/accounting/purchase-orders.ts:58` | INSERT. Status is not named, so it defaults to `draft` (246b). `po_items` INSERT `:70` has **no `gl_account_id`** |
| `pages/api/accounting/purchase-orders/[id].ts:168-182` | PUT: `status = COALESCE(${status}, status)` `WHERE status IN ('draft','submitted')`. No allow-list, so any CHECK value goes through, including `approved`. `approved_by`/`approved_at` are never stamped. Wrapper `withWriteAccess` (default roles owner/admin/manager, `src/lib/auth/writeRoles.ts:6`). UI select `pages/accounting/purchase-orders/[poId].tsx:440-445` |
| `src/modules/accounting/services/ap/goodsReceivedService.ts:55-59` | GRN: CASE → `received` / `partially_received` / `approved`. Takes `take_number_lock(co,620)` and then PO `FOR UPDATE` (`:12-14`), and refuses unless `approved`/`partially_received` (`:17`) |
| `pages/api/accounting/bank-match-confirm.ts:186` | `status = 'paid'`, which is not in the CHECK; finding 8a |

Status CHECK (`246b_purchase_orders.sql:10-11`): `draft, submitted, approved, partially_received, received, cancelled`.
No later migration alters `purchase_orders` or `po_items` (`git grep -n -E 'ALTER TABLE .*(purchase_orders|po_items)' -- scripts/migrations/sql` → 0).

Status readers relevant to commitment: `bankMatchDbQueries.ts:181` (`approved`, `partially_received`),
`purchase-orders/unmatched.ts:46-51` (reads `quantity_invoiced`), `goodsReceivedService.ts:17`.
`quantity_invoiced` has **0 writers** (`git grep -n quantity_invoiced -- src pages` → only `unmatched.ts:4,51`).

**Readers of `purchase_orders.approved_by` / `approved_at`: none by name.**
```
for f in $(git grep -l -E "purchase_orders|purchase-orders|purchaseOrder" -- 'src/**' 'pages/**' ':!*.md'); do git grep -n -E 'approved_by|approved_at|approvedBy|approvedAt' -- "$f"; done
```
Every hit is a `supplier_invoices` or `supplier_payments` column. The PO columns leave only through `SELECT po.*` in the
GET of `purchase-orders/[id].ts:56` and the list `purchase-orders.ts:25-29`, and no UI reads them. `approved_by` is
`TEXT` (246b:17).

## T1.3 `report_commentary` readers

```
git grep -n -E 'report_commentary' -- 'src/**.ts' 'src/**.tsx' 'pages/**.ts' ':!*.md'   → 13 lines, 6 files
```
| reader | file:line | `report_kind` filter | budget_variance row |
|---|---|---|---|
| `listCommentary` | `commentary/commentaryService.ts:27-35` | `= 'pack'` | safe |
| `generateDrafts` (INSERT/ON CONFLICT) | `commentaryService.ts:82-98` | writes `'pack'`; the unique key includes kind (`611:49-50`) | safe |
| `packDraftState` | `packs/pages/packDraftState.ts:59` | via `listCommentary` | safe |
| share link `loadApprovedCommentary` | `share/sharedPackService.ts:36-45` | `= 'pack'` | **safe, no leak** |
| GET `/api/accounting/commentary` | `pages/api/accounting/commentary/index.ts:37` | via `listCommentary` | safe |
| `currentRow` (by id) | `commentary/commentaryRow.ts:56-63` | **none** | read by approve/reject |
| `approveCommentary` | `commentary/commentaryApprove.ts:34, 46, 62, 79-93` | none (by id) | **mis-charged**, see below |
| `printsOnFixedPage` | `commentary/commentaryBudget.ts:16-20` | none: hash-match against `PACK_TYPES` | **returns true for a variance row** (fail-closed default) |
| `lockAndReadPack` | `commentaryBudget.ts:47-53` | filters by the row's **own** `report_kind` + `params_hash` | costs variance rows only against each other |
| `rejectCommentary` | `commentaryService.ts:115-132` | none (by id) | works on a variance row |

What exactly goes wrong for a `budget_variance` row:
- **Mis-charge.** `printsOnFixedPage` treats the row as a board pack. Approving a variance note therefore takes advisory
  lock 611 on `<co>:budget_variance:<hash>` and costs the note, **together with every other approved variance note of
  the same (version, month)**, against `MAX_APPROVED_PACK_EMS`. A single note's ceiling becomes the page-4 budget
  instead of `MAX_UNBUDGETED_CHARS`. It is not charged against the board pack itself, because the lock and the read are
  scoped by kind.
- **Leak: none.** Every pack, share and list reader filters `'pack'`.
- **Second path.** `POST /api/accounting/commentary/[id]/approve` (owner/admin, `approve.ts:52`) and
  `/reject` (`withWriteAccess` defaults, which include manager, `reject.ts:30`) act on any row by id. So a variance note can be approved
  or rejected through the pack routes, bypassing P5's holder and approver rules. P5 should either refuse
  `report_kind <> 'pack'` there or accept that path deliberately.
- `report_kind` has no CHECK in `report_commentary` (`611_report_commentary.sql:22-46`; `610`'s
  `share_links_kind_chk` is on `report_share_links` only). That confirms no migration is needed.

## T1.4 P1–P3 names on this tree

| Spec name | Status | Real name / location |
|---|---|---|
| `budget_versions` | ✓ | `947_budget_versions.sql:85`; `is_primary`, status `draft/approved/locked` |
| `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id` | ✓ | 947 (~`:280-286`); `month DATE` (first of month, `944:65`), `amount NUMERIC(15,2)` |
| lock trigger `public.budget_month_amounts_refuse_locked()` | ✓ (function) | function `947:423`; trigger **`trg_budget_month_amounts_refuse_locked`** `947:458`, `ENABLE ALWAYS` `:461`. It takes `FOR SHARE` on the `budget_versions` row (`:434`, `:443`), which matters for a slice-review trigger beside it |
| `services/budgets/` + `.claude.md` | ✓ | `.claude.md` present (also `tracking/.claude.md`) |
| `budgetVersionScope.ts` `primaryVersionScope` | **✗ wrong** | removed in P3 PR-C (`budgets/tracking/.claude.md:44`). Use `primaryVersionScopeAndYears(companyId, startDate, endDate) → {scope: VersionScope[], years}` (`:152`) for a window, or `readVersion(companyId, fiscalYear, versionId?)` (`:170`) for one year |
| `resolvePrimaryVersion` | ✓ | `resolvePrimaryVersion(companyId, fiscalYear, {create, actor?}) → id \| null` (`:49`); with `create:false` it never writes. Also `holdYearRegistry` (`:41`, shared `fy-end-change:<co>`) |
| `budgetVersionStatus.ts` `transitionVersion` | ✓ | `transitionVersion(companyId, versionId, {action:'approve'\|'lock'\|'unlock', reason?, expectedUpdatedAt?}, actor)` (`:26`) |
| `gridSave.ts` `saveCells` | ✓ | `saveCells(companyId, userId, raw: SaveCellsInput): Promise<SaveCellsResult>` (`:84`) |
| `gridReadModel.ts` | ✓ | `loadGridReadModel(companyId, sel, access)` (`:105`), `loadGridCells` (`:96`) |
| UI `components/accounting/budgets/workspace/` | ✓ | `BudgetGrid.tsx`, `VersionsBar.tsx`, … |
| `budgets/tracking/trackingActualRead.ts` | ✓ | see below |
| BvA components `components/accounting/budgets/tracking/` | ✓ | incl. `useBudgetTracking.ts` (P5 precondition) |
| management pack `budget_variance` / `income_vs_budget` | ✓ | `afs/managementPackGeneratorService.ts:66-71` |
| `tests/unit/services/afs/managementPackComparisonMode.test.ts` | ✓ | P5 precondition |
| `budget_month_amounts_one_grain` | ✓ | `947:644-647` |
| `permissionService.ts` | path | `src/lib/auth/permissionService.ts` |
| (P2 PR-D precondition, not P5's) `components/accounting/budgets/useBudgetAccounts.ts` | ✗ | absent on this tree |

**The actuals read.** `readTrackingActuals(companyId, startDate, endDate, filter: TrackingFilter = {}, groupBy: 'cc1'|'cc2'|'bu'|null = null): Promise<ActualRow[]>`
(`trackingActualRead.ts:45`). Each row is `{accountId, accountCode, accountName, accountType, accountSubtype, month:'YYYY-MM', memberId|null, amount, lastPosted}`.
It counts posted journals only, leaves out the year-end close, and covers revenue and expense accounts; the expense
sign is debit − credit.

Calling it per key is limited:
- There is **no account filter**.
- A filter value of `null` means *unfiltered*, never "untagged", so the "unassigned slice" (a line with no dim under a
  dim-grain account) cannot be selected by filter.
- Only **one** `groupBy` dimension is allowed. That matches decision 14.

The workable pattern is the one `priorActuals.ts:57` uses. Make one call per window and grain dimension
(`groupBy = grain === 'company' ? null : grain`), then pick rows by `(accountId, memberId, month)`; `memberId = null` is
the untagged slice. Calling once per key with `{cc1: X}` works for a tagged slice but repeats a company-wide aggregate
each time.

**Grain (decision 4).** There is no grain table. It is the generated column `budget_month_amounts.dim_grain`
(`947:288-292`: 0 company, 1 CC1, 2 CC2, 4 BU). `budget_month_amounts_one_dimension` CHECK allows ≤1 dim per row
(`947:~298`), and the EXCLUDE gist `budget_month_amounts_one_grain (version_id =, gl_account_id =, dim_grain <>)`
(`947:646-647`) allows one grain per account per version. Reads: `gridSave.ts:243`, `gridSaveValidate.ts:48`. An
account's grain in a version is the single `dim_grain` of its rows in that version; no rows means "No budget".

## T1.5 Line columns and posting date

**`po_items`** (`246b:30-45`, never altered): `id, purchase_order_id (FK CASCADE), product_id, description, quantity
NUMERIC(15,2) >0, unit_price, tax_rate DEFAULT 15, line_total NUMERIC(15,2), tax_amount, quantity_received,
quantity_invoiced, gl_account_id (FK gl_accounts), sort_order, created_at`. It has no `company_id` (scope comes through
the parent; RLS in `497`/`713`) and **no dimension columns**. `line_total` = qty × unit_price, ex-VAT, on both writers
(`purchase-orders.ts:68`, `[id].ts:201`).

**`supplier_invoice_items`**:
- `201:62-76`: `id, supplier_invoice_id (FK CASCADE), po_item_id UUID (no FK; partial index idx_sii_po_item),
  description, quantity NUMERIC(12,4), unit_price, tax_rate, tax_amount, line_total, gl_account_id, project_id,
  cost_center_id, created_at`.
- Added later: `vat_classification` (`210:24`); `line_match_status, qty_variance_pct, price_variance_pct,
  match_computed_at` (`413:21`); `updated_at` (`281:22`); `cc1_id, cc2_id` → `cost_centres`, `bu_id` →
  `business_units`, all RESTRICT (`870:22-25`).
- No `company_id`.
- The ex-VAT amount is `line_total` with the caveat in finding 3; the posted per-line debit comes from `buildExpenseLines`.

**Journal date.** `entryDate: invoice.invoiceDate` (`supplierInvoiceWorkflowService.ts:147` approve, `:264` post) →
`ledgerEntryDay()` (`journalEntryCrudService.ts:172`, `gl/journalDateGuard.ts:59`). The month is the `invoice_date`
month. A late VAT claim (`allowLateInputClaim`) moves only VAT, which I infer from `vatLateClaimPlan` naming; medium
confidence.

## T1.6 Notifications and cron

- **No notification store.** `ls scripts/migrations/sql | grep -i notif` and
  `git grep -i 'CREATE TABLE IF NOT EXISTS \w*notification' -- scripts/migrations/sql` both return 0.
  `AppLayout.tsx` has no "notification" match, and `src/components/layout/` has no bell.
- **Cron pattern.** Route `pages/api/cron/expectations-daily.ts`: `CRON_SECRET` check `:27`, header `x-cron-secret`
  `:32`, `timingSafeEqualStr` `:33`, `withErrorHandler` and no `withAuth` (`:46`). It calls
  `capture/expectationCronService.runDailyExpectationCron` (`:45`, its own companies SELECT `:53`).
  - Units: `scripts/isaflow-expectations.timer` (07:00 Africa/Johannesburg, `Persistent=true`) and
    `scripts/isaflow-expectations.service` (oneshot curl; the secret goes on stdin via `-H @-`; `POST
    http://127.0.0.1:3101/api/cron/expectations-daily`).
  - Other units: 10 pairs in `scripts/isaflow-*.{timer,service}`.
- **`loadActiveCompanies`** is **not shared**. There are three private copies: `practice/practiceNotificationService.ts:46`
  (the R-162 form: `status` not suspended/deleted, `suspended_at IS NULL`), `practiceMonthlyReportService.ts:81` and
  `practiceRecurringTaskService.ts:34`. P5 must copy or extract one.
- Cron code has no request transaction: `withAlsTransaction` sets **no** RLS GUCs (`src/lib/alsTransaction.ts:38-42`).
  See finding 9.

---

## T2 Lock-order census

### Inside `approveInner` (`supplierInvoiceWorkflowService.ts:53-170`), in order

| # | step | lock |
|---|---|---|
| 0 | `assertNotImpersonating` `:47` | one read, no lock |
| 1 | `SAVEPOINT approve_supplier_invoice` `:50` | — |
| 2 | `lockSupplierInvoiceForUpdate` `:69` | **`supplier_invoices` row FOR UPDATE**, 5 s, typed timeout (`supplierInvoiceLock.ts:95-101`) |
| 3 | `assertBillApprovable` `:77` | `approval_requests` read and currency read; no lock (`gl/approvalGate.ts`, no FOR/advisory) |
| 4 | **reuse branch** `:101-112` | `UPDATE supplier_invoices` (row already held); returns, no further locks |
| 5 | `claimEvidencedProvisional` `:114` | **provisional `gl_journal_entries` FOR UPDATE OF je**, ORDER BY id, 5 s (`provisionalSettlementClaim.ts:76-90`), then its **chain head FOR UPDATE** (`:98`, `journalChainHead.ts:135-155`). Only when the bill's `source_document_id` evidences one |
| 6 | `assertBillPostable` `:121` | **`gl_accounts` FOR SHARE** ORDER BY id (`billLineAccountGuard.ts:113`) |
| 7 | `placeCostCentres` / `assertPostsStoredDimensions` `:122-124` | reads |
| 8 | `createJournalEntry` `:146` | header guard **`gl_accounts` FOR KEY SHARE** (`headerAccountGuard.ts:94`); **`cost_centres` / `business_units` FOR SHARE** (`journalCostCentreValidation.ts:48,63`); **VAT `pg_advisory_xact_lock_shared(co,570)`** (`journalVatLockGuard.ts:129,204`); `ensureFiscalPeriodForDate`, which may take **`fiscal_years` FOR UPDATE** when it generates a year (`942:105`); INSERT `gl_journal_entries` → **journal-number `pg_advisory_xact_lock(co:year, 857)`** in the trigger (`858:163`, bounded only by the caller's `lock_timeout`); line INSERT FK key-shares |
| 9 | `postJournalEntry` `:153` | own new JE FOR UPDATE (`journalEntryPostService.ts:35`); period status read; VAT shared 570 again; a late-claim split may create a second JE (857 again) |
| 10 | `UPDATE supplier_invoices` `:155` | row already held |
| 11 | `settleClaimedProvisional` `:162` | only with a claim: reclass JE (`provisionalInvoiceSettlement.ts:90-102`, 857), `INSERT supplier_payments` (`:108`; SP number under 857 per `858:225`), apply with `paymentCreatedInThisRequest: true` (`:123-124`), so **no supplier credit key** and the bill row is already held |

**`postToGLInner`** (`:187-284`): `lockSupplierInvoiceForUpdate` `:205`, cancelled/journal early return `:214-220`,
population refusal `:231`, then steps 5, 6, 7, 8, 9, 10 (`:275`, journal id only) and 11, in the same order.

No explicit `suppliers` lock is taken on either path, and no supplier-credit key. Supplier `FOR KEY SHARE` comes only
from FK checks: the `supplier_payments` INSERT in step 11, and in the INSERT of a bill created in the same transaction
(recurring, capture).

### Locks held before the call, per caller path

| path | held before approve/post (in order) | budget lock first? |
|---|---|---|
| UI single `supplier-invoices-action.ts:60` | none. `withAuth`/`withCsrf`/`withWriteAccess` take no row or advisory lock (grep of `src/lib/auth` for FOR/advisory hits only `routeAdminPool.ts`, a separate pool) | **Yes**, inside approve, before `:69` |
| UI bulk approve / post_gl `supplier-invoices-bulk-action.ts:119-137` | before the loop: `billNumbers` (plain read in a savepoint, `:76-87`). At item k: everything items 1..k-1 took (invoice rows, accounts FOR SHARE, VAT 570 shared, **857 company:year**, provisional JEs) | **Yes, only if taken once before the loop** (between `:117` and `:121`) and outside the item savepoint. Per item = deadlock (finding 6) |
| MCP single `writeSupplierInvoices.ts:191` | registry **idempotency advisory lock** `mcp:<co>:<tool>:<key>` (`registry.ts:155`, `audit.ts:63`); handler pre-reads unlocked (`:171-182`) | **Yes** (inside approve). Order idem → budget is the same for every MCP call and the key is per call, so no cycle |
| MCP bulk `writeBulkApproveSupplierInvoices.ts:230` → `bulkApprovePost.ts:71` | idempotency lock; `partitionDocuments` / `resolvePeriodSkips` / `supplierInvoiceLineAccountRefusals` / `invoiceVatRefusals` / `agentApprovalRefusals` are all unlocked reads (`billLineAccountGuard.ts:147-157` has no FOR SHARE) | **Yes, if taken once in the handler before `postPartitionedDocuments` (`:230`)**. Per element = the same deadlock as the bulk route |
| Capture `ai-invoice-pipeline.ts` → `provisionalAttachSettle.ts:59` | `captured_documents` FOR UPDATE (`:87`); capture events FOR UPDATE (`:88`); posted-content advisory `hashtextextended(<co>:sha:…,0)` (`capturePostingClaim.ts:193`, `postedContentFence.ts:69`); claim UPDATE (`:196`); INSERT `supplier_invoices` approved (`:203`, FK key-share supplier); `attachEvidenceToProvisional`: **UPDATE `bank_transactions`** and **UPDATE provisional `gl_journal_entries`** (`evidenceAttachmentService.ts:129,142`) | **No** inside post. Possible only at the route top, before `:87` |
| Capture `capture/[id]/post.ts` → `capturePostFollowUps.ts:86` | event + document FOR UPDATE (`lockCaptureEventForPosting`, `:76`); posted-content advisory and claim (`:206`); INSERT approved bill (`:228`); attach, as above | **No** inside post. Possible only at the route top, before `:76` |
| Recurring `recurringTransactionInvoices.ts:226` | `recurring_transaction_templates` FOR UPDATE 5 s (`recurringTransactionService.ts:172`); template line accounts **FOR SHARE** (`recurringTransactionInvoices.ts:152`); **`company_document_numbers` row UPDATE** (`insertWithReservedNumber` → `companySettingsService.ts:~176`); INSERT bill + items (`:177`) | **No** inside approve. Possible only in `executeRecurring` before `:172` |
| Sandbox script `reviewerSandboxBooks.ts:123` | dev only | n/a |

### Can a budget lock taken first avoid deadlock? Documented exceptions

**Achievable inside approve** (company lock before `lockSupplierInvoiceForUpdate`): UI single, MCP single.

**Achievable only if the caller takes it once before its loop:** the UI bulk route and the MCP bulk tool.
- It must be outside the per-item savepoint, because a rolled-back savepoint releases a lock taken inside it.
- Re-taking it inside approve is then harmless: `pg_advisory_xact_lock` is re-entrant per session.

**Exceptions** (they hold document locks before approve/post):
1. **Capture post-to-GL** (both routes, via `provisionalAttachSettle`).
2. **Recurring auto-post.**

If either takes the company lock inside approve/post, it holds it after document/template/number/bank-line/provisional
locks. My inference about deadlock risk:
- A block-mode approver holding the company lock would need one of those same rows to close a cycle. The candidates are
  this request's new bill (invisible to others), the template row, the document-number row, the posted-content key and
  the captured document. None of these is touched by approve/post of a *different* bill.
- The shared rows are the provisional JE and the bank line. A provisional is claimed only through
  `source_document_id = <this capture's document>`, which the capture claim makes unique. So a cycle needs a second bill
  on the same captured document, which the claim prevents.
- Residual risk is therefore low but **not proven**.

Options: (a) take the lock at the route top (`ai-invoice-pipeline.ts` before `:87`, `capture/[id]/post.ts` before
`:76`, `executeRecurring` before `:172`), reading the policy first; or (b) run these in the spec's lock-free "refuse if
over" mode as a named residual race. Capture also needs its refusal mapped: `provisionalAttachSettle` withdraws to draft
on a non-held error, so a lock timeout must stay a held/retryable error (`isHeldRowError`) or it will silently withdraw
the approval.

**Other locks that could cross the company lock:**
- The 857 journal-number key, held by any earlier posting in the same transaction. Only the bulk loops do this today.
- VAT 570 (shared; the exclusive holder, VAT lock, takes no budget lock).
- `fy-end-change:<co>` if `remainingFor` calls `holdYearRegistry`. Shared, and its exclusive holder takes no budget
  lock, so there is no cycle unless the year-end change starts approving bills.
- Grid writes (`lockVersionForWrite` UPDATE on `budget_versions`, and the 947 trigger's FOR SHARE). The check only
  reads `budget_month_amounts`, so no conflict.

### Reused-journal approve branch

It exists at `approveInner:101-112`. It runs after the invoice lock, the status refusal and `assertBillApprovable`, and
before `claimEvidencedProvisional`, `assertBillPostable` and every journal step. It only sets
`status='approved', approved_by, approved_at` and returns; it posts nothing and settles nothing.
- It is reachable only for a draft or pending bill that already has `gl_journal_entry_id`. Since R-118 no app path
  creates one (`postToGLInner:231`), so in practice it is legacy rows only.
- The journal is posted, so the bill's spend is already in `readTrackingActuals`.
- Recommendation: skip the budget check on this branch (event `pass`, note "already posted"). See finding 2.
- Separately, `postToGLInner:218-220` returns `alreadyPosted` for any bill carrying a journal, before the population
  refusal, so it needs no check either.
