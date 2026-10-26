# P5 — Controls & collaboration (spec)

**Parent:** `docs/plans/2026-10-26-budgets-next-level.md` §5 P5 · **Contract:** `docs/plans/budgets/00-shared-contract.md` (obeyed exactly; canonical names from P1).
**Status:** planned, not built. **Precondition:** P1–P3 merged and live; refresh this spec against MVP feedback before execution.
**Base when written:** `origin/master` 37992605a, migration head 946.

**Strongest argument against this phase:** the budget check puts a new refusal into the one AP path that posts
money (`approveSupplierInvoice`), and the path already carries a long list of lock-order fixes (see
`src/modules/accounting/services/ap/.claude.md`). A control nobody asked for that adds a deadlock is worse than no
control. That is why the check runs lock-free in `warn` mode, takes its lock only in `block` mode, and why the
lock-order census (T2) comes before any code.

---

## 0. Phase-start decision gate (Hein answers yes / override before T1)

| # | Decision | Pre-filled default |
|---|----------|--------------------|
| 8 | Budget check on supplier-invoice / PO approval | Setting per company: `off \| warn \| block`, **default `warn`**. **warn**: approval goes ahead. A human approving in the UI must type a reason when any line is over budget. Bulk and MCP callers get `warnings[]` and an audit row marked `no_reason`. **block**: the approval is refused with 409 `BUDGET_EXCEEDED`. Owner or admin can override on a **single** approve with a mandatory reason; bulk and MCP cannot override. A line whose slice has **no budget row** is reported as "No budget" and is never blocked. A deliberate zero budget *is* a budget, so it blocks. |
| 8a | Which spend counts against remaining | Budget − posted actuals − **open PO commitments** (approved POs, less ex-VAT bill items already linked to each `po_item_id`). The bill being approved excludes its own PO lines' commitment. |
| 8b | Month a document hits | Bill: `invoice_date` month (the journal's `entry_date`). PO: `order_date` month. |
| 8c | PO approval | A dedicated `approve` action replaces setting `status='approved'` through the PUT. The PUT stops accepting `approved`. Roles: owner, admin, manager, as today. |
| 9 | Overspend alerts | In-app to owner and admin. Evaluated by a **daily scheduled run** plus an owner/admin "Evaluate now" button. Thresholds default to 80% / 100% / 120% per account, overridable per account or slice. The email digest is built and **off** (per-company flag false, plus env kill-switch `BUDGET_ALERT_EMAIL_ENABLED` unset) until Hein enables it. |
| 9a | Budget holders | Must hold role `manager` (or higher). Owners and admins see every slice implicitly. A holder edits only their slice, and only on a `draft` version. A version cannot be approved while any assigned slice is not `approved`, unless the owner forces it with a reason (audited). |

---

## 1. What exists (verified on `origin/master`) — reuse, do not rebuild

- **Bill approval:** `src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts`.
  - `approveSupplierInvoice` → `approveInner`: invoice `FOR UPDATE` (`supplierInvoiceLock.ts`), `assertBillApprovable` (`billPostingGuard.ts`), journal post, status UPDATE. It already returns `warnings?: string[]`.
  - Callers: `pages/api/accounting/supplier-invoices-action.ts` and `supplier-invoices-bulk-action.ts` (one transaction, a savepoint per item); MCP `writeSupplierInvoices.ts` and `writeBulkApproveSupplierInvoices.ts`; `capture/provisionalAttachSettle.ts`; `core/recurringTransactionInvoices.ts`.
  - **Bypass to close:** `postSupplierInvoiceToGL` posts a *draft's* expense journal with no approval (the "Post to GL" bulk action). In `block` mode it must run the same check. Otherwise "post, then approve" escapes the control, and the reused-journal approve branch is never checked.
- **Bill lines** carry `gl_account_id`, `cc1_id`, `cc2_id`, `bu_id` (mig 870 on `supplier_invoice_items`), plus `po_item_id`. The header carries `purchase_order_id`.
- **POs:** two schemas exist.
  - `purchase_orders` / `po_items` (mig `246b`) is the live one: nav "Purchase Orders" → `/accounting/purchase-orders`, `pages/api/accounting/purchase-orders/[id].ts`, `goodsReceivedService.ts`. It has **no approve action**: `status` is set to `approved` through the PUT by any write role (`pages/accounting/purchase-orders/[poId].tsx` status select), and `approved_by` is never stamped. `po_items` has **no dimension columns**, and `quantity_invoiced` is read but **never written**.
  - `supplier_purchase_orders` (mig 247) has no `approved` status. It is out of scope.
- **Alerts / notifications:** there is **no** per-user in-app notification store and **no** header bell (checked in `src/components/layout/AppLayout.tsx`; no `*notification*` table in `scripts/migrations/sql/`). The count badge next to Search in the prod header (e.g. "13") is `src/components/onboarding/SetupGuideButton.tsx`: remaining setup-guide tasks, computed from `GET /api/accounting/setup-guide` plus the user's `setup-guide-manual-done` preference. It is not a store, has no per-item rows or read state, and is not reusable for alerts; the new bell sits beside it and must not be confused with it (different icon and label).
  - Nearest pattern: `compliance_alerts` (mig 345: per-company, dedupe via a partial unique index `WHERE dismissed_at IS NULL`), `afs/complianceAlertService.ts`.
- **Email:** `core/emailService.ts` `sendEmail`. Digest pattern: `practice/practiceNotificationService.ts` + `src/lib/email-templates-practice-digest.ts`. Per-company send flag pattern: `chase_auto_send_enabled` in `pages/api/cron/expectations-daily.ts`.
- **Cron:** `pages/api/cron/*.ts` (`X-Cron-Secret`, `timingSafeEqualStr`), triggered by `scripts/isaflow-*.timer` + `.service`. Installing a timer on velo-server is ops work and needs Hein's OK.
- **Commentary:** `report_commentary` (migs 611/612), `services/commentary/*`, `components/accounting/commentary/*`. It has a draft → approved status machine, approve-with-edits, and `commentaryLimits` text validation.
  - Packs read it via `packs/pages/packDraftState.ts` (`listCommentary`, approved only). The share link reads it via `share/sharedPackService.ts` (`report_kind = 'pack'`).
  - **Trap:** `commentaryBudget.printsOnFixedPage` treats any row whose `params_hash` matches no pack type as a board-pack row and charges it the page-4 ems budget (fail closed). A variance row filed in this table would be charged against every other variance note for the same month. P5 must scope that check to `report_kind = 'pack'`.
- **Roles:** `AuthRole` in `src/lib/auth/types.ts`; write roles in `writeRoles.ts`. Module permissions in `permissionService.ts` (mig 270, `company_user_permissions`) have account ranges but no dimension scope.
- **Locks:** `core/rowLockBudget.ts` (bounded `lock_timeout`, typed retryable error → 503).
- **Audit:** `core/auditTrailService.ts` `logAuditOrThrow`; the `budget` entity filter already exists in `pages/accounting/audit-log.tsx`.
- **From P1–P3 (names from their specs; precondition checks in the contract; confirm against master at phase start):**
  - P1: `budget_versions`, `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id`, lock trigger `public.budget_month_amounts_refuse_locked()`, `src/modules/accounting/services/budgets/` and its `.claude.md`, `budgetVersionScope.ts` (`primaryVersionScope`, `resolvePrimaryVersion`), `budgetVersionStatus.ts` `transitionVersion` (the version Approve that §3f gates).
  - P2: `budgets/gridSave.ts` `saveCells`, `budgets/gridReadModel.ts`, UI `src/components/accounting/budgets/workspace/` (holder mode goes here).
  - P3: the one actuals SQL `budgets/tracking/trackingActualRead.ts`; the BvA page components `src/components/accounting/budgets/tracking/`; the management-pack `budget_variance` / `income_vs_budget` sections in `afs/managementPackGeneratorService.ts`; the board-pack Budget column.

## 2. Schema sketch (ONE migration, NEW `scripts/migrations/sql/<next free prefix>_budget_controls.sql` — prefix taken at commit time, contract "Migration prefixes"; Hein OK before merge)

Every table has `company_id uuid not null`, forced RLS with the `budget_month_amounts` tenant policy, and a same-company trigger for every FK to a tenant table. Every `CREATE ... IF NOT EXISTS`.

```
budget_control_settings (company_id pk, check_policy text check in ('off','warn','block') default 'warn',
  alert_email_enabled boolean not null default false, default_thresholds numeric[] not null default '{80,100,120}',
  updated_by, updated_at)                          -- no row = defaults; owner/admin write only (API)

budget_alert_thresholds (id, company_id, gl_account_id, cc1_id, cc2_id, bu_id null, thresholds numeric[] not null,
  unique (company_id, gl_account_id, cc1_id, cc2_id, bu_id) NULLS NOT DISTINCT)   -- PG 15.8 supports it (P1 spec §2)

budget_alerts (id, company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month date, threshold numeric,
  budget numeric(15,2), actual numeric(15,2), committed numeric(15,2), pct numeric, fired_at, resolved_at null,
  unique (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, threshold) NULLS NOT DISTINCT)

user_notifications (id, company_id, user_id, kind text check in ('budget_alert','budget_slice','budget_reminder'),
  ref_id uuid, title text, body text, href text, dedupe_key text not null, created_at, read_at null,
  unique (company_id, user_id, dedupe_key))       -- generic; first consumer is budgets

budget_check_events (id, company_id, document_type text check in ('supplier_invoice','purchase_order'),
  document_id uuid, policy text, outcome text check in ('pass','warn','override','refused'),
  lines jsonb not null, reason text null, channel text check in ('ui','bulk','mcp','system'),
  decided_by, decided_at)  -- INSERT-only for app pools (no UPDATE/DELETE grant): an override record cannot be rewritten

po_items += cc1_id, cc2_id, bu_id (nullable, RESTRICT FKs exactly as 870 on supplier_invoice_items)

budget_holders (id, company_id, version_id, user_id, cc1_id, cc2_id, bu_id, gl_account_ids uuid[] null,
  unique (company_id, version_id, user_id, cc1_id, cc2_id, bu_id) NULLS NOT DISTINCT)

budget_slice_reviews (id, company_id, version_id, cc1_id, cc2_id, bu_id, status text check in
  ('open','submitted','returned','approved'), due_date date null, submitted_by/at, decided_by/at,
  decision_note text, updated_at, unique (company_id, version_id, cc1_id, cc2_id, bu_id) NULLS NOT DISTINCT)
```

DB-level rule (trigger on `budget_month_amounts`, alongside P1's lock trigger):
- A write to a slice whose `budget_slice_reviews.status IN ('submitted','approved')` is refused unless the session is the reviewer's approve/return path, which sets a transaction-local GUC through a SECURITY DEFINER helper and therefore needs an `app_definer_reviews` row (mig 930 registry).
- [agent decides: trigger vs service-only enforcement; the trigger is the default, proven as app_user.]

## 3. Semantics

### 3a. Remaining budget (one pure core + one reader)

NEW `src/modules/accounting/services/budgets/remainingBudget.ts`:

```
remainingFor(companyId, keys: Array<{glAccountId, cc1Id, cc2Id, buId, month}>, opts: {excludePoItemIds?, excludeInvoiceId?})
  → Array<{key, grain, budget: number|null, actual, committed, remaining: number|null}>
```

- **Version:** the primary version for the fiscal year containing `month` (contract: readers use primary). No primary version means budget `null` → "No budget".
- **Grain:** decision 4 — one grain per account per version.
  - Map the line's dims onto the account's grain: keep the grain's dims, drop the rest. A grain dim the line lacks becomes an "unassigned slice", reported as No budget.
  - Company grain uses all dims NULL.
- **Actual:** posted `gl_journal_lines` for the account, slice dims and month, debit − credit for expense, read through P3's `budgets/tracking/trackingActualRead.ts` (never a second formula). Invariant 1 applies: it equals the BvA Actual for the same key.
- **Committed:** Σ over `po_items` on POs with `status IN ('approved','partially_received','received')`, in the order month, of `line_total − Σ(ex-VAT supplier_invoice_items.line amount WHERE po_item_id = pi.id AND bill status IN ('approved','paid','partially_paid'))`, floored at 0.
  - Derived from the bill linkage, not from `quantity_invoiced`, which nothing writes.
- **The document itself:** its own ex-VAT line amounts, summed per key, compared against `remaining`.
  - A line is over when `own > remaining`.
  - The reused-journal approve branch (`glJournalEntryId` already set) is already in actuals: subtract its own amount from actual first, or skip the check, whichever T2 shows is correct.

### 3b. Budget check at approval

NEW `budgets/budgetCheck.ts`:
- `checkDocumentBudget(companyId, doc, {reason, channel, actorRole}) → {outcome, lines, warnings}`.
- `BudgetExceededError` (code `BUDGET_EXCEEDED`, 409, message names each over line: account, slice, month, remaining, amount).
- `BudgetReasonRequiredError` (`BUDGET_REASON_REQUIRED`, 400).

Call sites, each **under the document lock, before the first write**:
1. `approveInner`, right after `assertBillApprovable`.
2. `postToGLInner` (block mode only; warn mode returns warnings).
3. The NEW PO approve service.

| policy | over-budget lines | UI single | bulk / MCP | system callers (recurring, provisional attach) |
|---|---|---|---|---|
| off | — | pass, no event | pass | pass |
| warn | none | pass, event `pass` only if any line was checked | same | same |
| warn | ≥1 | needs `reason` (else `BUDGET_REASON_REQUIRED`); event `warn` | proceed, `warnings[]`, event `warn` with `reason=null` | proceed, event `warn`, channel `system` |
| block | ≥1 | refused, unless owner/admin sends `override:true` + `reason` → event `override` | refused (item fails, batch continues) | refused, surfaced the way each caller surfaces other refusals |

The event row is written in the same transaction as the approval. A refused approval writes its `refused` event in its own savepoint and rolls the rest back (≥500 rolls back; 4xx COMMITs under `withAuth` — memory "4xx commits writes"). Every event also writes `logAuditOrThrow` with entity `budget`.

### 3c. Concurrency — the decision

- **warn: no lock.** Two racing approvals can both see the same remaining amount and both proceed. That is acceptable: warn is advisory, both events are recorded, and the overspend alert catches the result.
- **block: a lock is required.**
  - Without one, two approvals each read R10k remaining, each approve R8k, and the budget overspends by R6k. A block control that a double-click defeats is not a control.
  - **Lock:** one transaction advisory lock per company, `pg_advisory_xact_lock(hashtextextended('budget_check:'||company_id, <mig prefix>))`, taken with a bounded wait (`rowLockBudget`-style `lock_timeout`, 5 s → typed retryable 503).
  - **Why per company and not per key:** per-key locks taken inside approve accumulate across a bulk approve (one transaction, savepoints do not release xact locks). Two bulk runs touching keys K1, K2 in opposite orders deadlock.
  - **Where:** first in the order — **before** the invoice `FOR UPDATE`. The service reads the policy without a lock, takes the company lock if the policy is `block`, then re-reads the policy under the lock. If the policy flipped to block between the two reads, it refuses with a retryable error.
  - **Bulk:** the bulk route and the MCP bulk tool take it once, before their loop (re-entrant in the same session).
  - **Cost:** it serialises block-mode approvals within one company only. SME volumes make that acceptable; warn and off pay nothing.
  - **Ordering trap:** callers that already hold an invoice or supplier lock when they call `approveSupplierInvoice` (`provisionalAttachSettle`, `recurringTransactionInvoices`, any MCP pre-read that locks) would take the company lock *after* the document. That reverses the order. T2's census lists every caller's held locks. Any caller that cannot take the company lock first runs the check in a lock-free "refuse if over" mode, documented as a known limit (residual race), not silently.
  - **Proof:** a real-PG race test (two concurrent approvals, each fitting alone, not together) is red with the lock mutated out and green with it. A two-bulk-runs opposite-order test proves no 40P01.

### 3d. Overspend alerts

NEW `budgets/overspendAlerts.ts` `evaluateOverspend(companyId, {asOf}) → {fired, resolved}`:
- **Scope:** the primary version and the months of the current fiscal year up to `asOf`.
- **Per key** at its budgeted grain: `pct = (actual + committed) / budget × 100`. Expense accounts only; revenue under-run is a P3 report concern, not an alert.
- For each threshold `t ≤ pct`, `INSERT ... ON CONFLICT DO NOTHING` (unique key = dedupe). Only a **newly** inserted row creates `user_notifications` for each owner/admin (`dedupe_key = 'budget_alert:'||alert_id`). Re-runs are idempotent.
- When `pct` falls below `t` (a reversal, or the budget raised), set `resolved_at`. Crossing it again inserts nothing (unique) unless the row is resolved. [agent decides: re-fire after resolve = clear `resolved_at` + a new notification; default yes.]
- **Trigger:**
  - Daily `POST /api/cron/budget-alerts` (NEW, `X-Cron-Secret`), across active companies (the `loadActiveCompanies` pattern).
  - Owner/admin `POST /api/accounting/budgets/alerts/evaluate` (NEW) for one company.
  - **Not on posting.** Posting paths are many (journals, bank allocations, payroll, MCP, imports). A hook in `postJournalEntry` would add reads and contention to every money transaction for a non-control signal. The control at the point of commitment is 3b.
- **Email digest** (NEW `budgets/overspendDigest.ts` + NEW `src/lib/email-templates-budget-digest.ts`):
  - Built and unit-tested on rendered HTML (escaped).
  - Sends only when `budget_control_settings.alert_email_enabled` **and** env `BUDGET_ALERT_EMAIL_ENABLED=1`.
  - Neither is set by this phase. Enabling it is Hein's act (a human gate).

### 3e. Variance commentary (reuse `report_commentary`)

- **Filing:** `report_kind = 'budget_variance'`, `params_hash = sha256('bva|'||version_id||'|'||month)` (NEW helper beside `packParamsHash.ts`, server-only), `period_start/end` = month bounds, `section_ref = 'account'`, `row_ref = gl_account_id||'|'||coalesce(cc1,'')||'|'||coalesce(cc2,'')||'|'||coalesce(bu,'')`.
  - No migration is needed for this table.
- **Write path:** NEW `commentary/varianceCommentary.ts` `saveVarianceNote` (human text → `draft_text`, `generated_by = 'human:'||uid`, validated by `commentaryLimits.editedTextProblem`), then the existing `approveCommentary`.
  - Writers: owner, admin, manager, plus a holder for their own slice.
  - Approvers: owner and admin.
- **Change to existing code:** `printsOnFixedPage` returns false when `report_kind <> 'pack'`. Add a test that a variance approval takes no pack budget or lock. Every existing `listCommentary` / share query keeps `report_kind = 'pack'`, so nothing leaks into share links.
- **Surfaces:**
  - The P3 BvA row (`src/components/accounting/budgets/tracking/`) shows a note icon. A popover shows the approved note, plus the draft labelled "Draft" for internal roles (owner/admin/manager, the `canReadSharingSurface` rule).
  - The management/monthly pack's `budget_variance` section (built by P3 in `afs/managementPackGeneratorService.ts`; P5 extends it, never rebuilds it) prints **approved** notes for the months in the pack range, under the variance table. They never reach page 4 prose.

### 3f. Budget-holder workspaces

- **Assign:** owner/admin assign holders to slices of a **draft** version (P2 grid "Holders" panel) and set `due_date` per slice. This creates `budget_slice_reviews` with status `open`.
- **Holder view:**
  - P2 grid filtered to their slices; other slices are hidden, and company roll-ups are read-only and limited to their slices. API-enforced, with the DB trigger (§2) as backstop.
  - `Submit` → `submitted`, which locks the slice for the holder and notifies owner/admin.
- **Reviewer:** `Approve` → `approved`, or `Return` with a mandatory note → `returned`, which unlocks the slice for the holder and notifies them.
- **Version Approve (P1's `transitionVersion`, called by P2's versions bar):** refused while assigned slices are not all `approved`, unless the owner forces it with a reason (audited).
- **Reminders:** the same daily cron writes `user_notifications` (`budget_reminder`) to the holder at due −3 days, on the due date, and when overdue (dedupe key per slice per stage). Reminders are in-app only.
- **Every transition** goes through ONE status function (`budgets/sliceReviewState.ts`, mirroring `commentaryState.ts`) and writes `logAuditOrThrow` entity `budget`. The UPDATE's WHERE repeats the from-state, so racing submits and approves cannot both win.

## 4. API (all `withAuth(withErrorHandler(withCsrf(withWriteAccess?(...))))`, `apiResponse`, company from session)

| Route (NEW unless noted) | Roles | Purpose |
|---|---|---|
| `GET/PUT /api/accounting/budgets/controls` | read: write roles; PUT: owner/admin | settings + threshold overrides |
| `POST /api/accounting/budgets/remaining` | write roles | preview for the approve dialog / PO form: lines → remaining |
| `supplier-invoices-action.ts` approve (**existing**) | as today | body gains `budgetReason?`, `budgetOverride?` (zod) |
| `supplier-invoices-bulk-action.ts` (**existing**) | as today | optional batch `budgetReason`; per-item `BUDGET_EXCEEDED` in failures |
| `POST /api/accounting/purchase-orders/[id]/approve` | owner/admin/manager | NEW approve action (stamps `approved_by/at`, runs check) |
| `purchase-orders/[id].ts` PUT (**existing**) | — | refuses `status: 'approved'` (400 pointing to approve) |
| `GET /api/accounting/budgets/alerts`, `POST .../alerts/evaluate` | owner/admin | list / run now |
| `GET /api/accounting/notifications`, `POST .../notifications/read` | any member, own rows only | bell feed + mark read (`user_id = session user` in every query) |
| `POST /api/cron/budget-alerts` | `X-Cron-Secret` | daily alerts + reminders |
| `GET/POST /api/accounting/budgets/variance-notes` | see 3e | list per version/month; save draft |
| `GET/POST /api/accounting/budgets/holders`, `POST .../slices/[id]/{submit,approve,return}` | see 3f | holders + slice workflow |
| MCP `approve_supplier_invoice`, `bulk_approve_supplier_invoices` (**existing**) | — | return `budget_warnings`; block refusals typed |

## 5. UI

- **Supplier invoice approve dialog** (`pages/accounting/supplier-invoices/[invoiceId].tsx`, existing): per-line remaining-budget table (account, slice, month, budget, actual, committed, remaining, this bill). Over lines are coloured via `ibcs.varianceColor`. Reason textarea (required when over in warn mode); owner/admin "Override" in block mode.
- **Bulk approve:** a modal shows the count over budget and takes one reason.
- **PO detail** (`pages/accounting/purchase-orders/[poId].tsx`, existing): an Approve button replaces the status select's `approved` option; the same remaining panel; per-line CC1/CC2/BU pickers (new columns).
- **Header bell** (NEW `src/components/layout/NotificationBell.tsx`, mounted in `AppLayout.tsx` next to `SettingsMenu`): unread count, dropdown of the latest 20, mark read, link to the source. Also in `MobileHeaderMenu.tsx`.
- **NEW pages:** `/accounting/budgets/controls` (settings, thresholds, alert list with Evaluate now) and `/accounting/budgets/review` (owner/admin slice board: open / submitted / returned / approved, due dates). Nav entries go in `src/components/accounting/navSections/*` via `accountingNavConfig.ts`.
- **Holder mode** of the P2 grid; **note popover** in the P3 BvA.
- Browser proof: dark AND light, 1280 px and 390 px, ISAFlow Demo on dev.

## 6. Task DAG

```
T0 §0 gate ─► T1 census (read-only) ─► T2 lock-order census ─► T3 migration ─┬─► T4 remainingBudget ─► T5 budgetCheck ─► T6 bill wiring ─► T7 PO approve
                                                                             ├─► T8 notifications + bell ─► T9 alerts + cron (+digest, off)
                                                                             ├─► T10 variance commentary
                                                                             └─► T11 holders + slice workflow + reminders (needs T8)
T12 docs/.claude.md + golden path ◄── all
```

| Task | verify: |
|---|---|
| T1 Census: contract precondition checks; every caller of `approveSupplierInvoice` / `postSupplierInvoiceToGL`; every writer of `purchase_orders.status`; every `report_commentary` reader and whether it filters `report_kind`; the P1–P3 names above confirmed | the census table is in the PR body; `git grep` counts match it |
| T2 Lock-order census: for each T1 path, the locks held before the approve call, and the order of invoice / supplier / payment / journal-number / company-budget locks | a written table; every path's order is consistent with "company budget lock first", or listed as a documented exception |
| T3 Migration (§2) | `CI_INTEGRATION=1 bun run ci` applies it as non-superuser; RLS test as app_user refuses a cross-tenant row in every new table; `budget_check_events` refuses UPDATE/DELETE as app_user; **Hein OK** |
| T4 `remainingBudget` | real-PG test: actual = the P3 BvA actual for the same key (invariant 1); committed nets the linked bill items; grain mapping; no primary version → null |
| T5 `budgetCheck` (policy matrix §3b) | unit test per matrix cell; real-PG race test (block): two approvals that each fit alone but not together → exactly one refused; mutation: remove the lock → both pass (red) |
| T6 Wire into `approveInner`, `postToGLInner`, routes, bulk, MCP | integration: warn + reason → approved + event + audit; block → 409, no journal, no status change; Post-to-GL then approve in block mode → refused; bulk opposite-order run ×2 → no 40P01; every existing AP guard suite listed in `ap/.claude.md` stays green |
| T7 PO approve + dims on `po_items` + PUT refusal | route tests; PUT `status:'approved'` → 400; commitment appears in remaining |
| T8 `user_notifications` + bell | API never returns another user's rows (test as two users); browser proof |
| T9 Alerts + cron + digest | rerun the cron ×2 → one alert and one notification per crossing; resolve on reversal; digest unit test on rendered escaped HTML; send path asserted NOT called with flags unset (mutation: flip the default → red) |
| T10 Variance commentary | a variance approval takes no pack lock and no ems charge; share-link query returns no variance rows; the pack prints only approved notes |
| T11 Holders + slices + reminders | a holder cannot write outside their slice (API 403 + DB trigger as app_user); submitted slice locked; racing approve/return → one wins; reminder dedupe across reruns; version approve refused with an open slice |
| T12 Docs | `.claude.md` for `budgets/` and `ap/` updated; `bun run agent-docs:check` clean; golden path green |

## 7. Tests and mutations (each mutation must turn its test red; record logs)

| Test (NEW, `tests/integration/budgets-p5-*.int.test.ts` unless noted) | Mutation |
|---|---|
| block race: two concurrent approvals | drop the advisory lock → both approved |
| block refuses with no write (journal count, status, `amount_paid` unchanged) | move the check after `createJournalEntry` |
| Post-to-GL bypass closed | delete the check in `postToGLInner` |
| warn needs a reason in the UI channel | default `reason` to `''` |
| no-budget slice never blocks; zero budget blocks | treat `budget = 0` as null (D5 regression) |
| committed nets the linked bill items | drop the `po_item_id` subtraction |
| `budget_check_events` immutable as app_user | add `GRANT UPDATE` |
| alert dedupe ×2 runs | drop the `ON CONFLICT` |
| notifications scoped to user | drop `user_id =` from the list query |
| email off by default | default `alert_email_enabled` true |
| variance row not charged against the pack budget | revert `printsOnFixedPage` scoping |
| holder outside slice refused at DB | disable the trigger |
| `tests/unit/services/budgets/budgetCheckMatrix.test.ts` (each matrix cell) | swap warn/block branches |

Playwright golden path (NEW `tests/e2e/golden-paths/<next free letter>-budgets-controls.spec.ts`), **dev-only**: it flips the company's check policy and approves bills (GL postings), so its file name goes into `playwright-golden.config.ts`'s `testIgnore` regex and it never runs in prod verify against Demo (contract golden-spec rule). Steps: set policy block → approve an over-budget bill → refusal shown → owner override with a reason → approved → audit log shows the `budget` entry → bell shows an alert after Evaluate now. Screenshot.

## 8. PR split

| PR | Content | Gate |
|---|---|---|
| P5-1 | T3 migration + T4 `remainingBudget` + T8 `user_notifications` API + bell | migration → **Hein OK**; touches `AppLayout.tsx` (existing) → Hein reads the diff |
| P5-2 | T5 + T6 bill-approval check | **money workflow**: Hein reads the diff + **adversarial reviewer** (real-PG repros on its own cluster) + blind `/review` + security review |
| P5-3 | T7 PO approve | changes existing PO behaviour → Hein reads the diff + adversarial review |
| P5-4 | T9 alerts + cron + digest (off) | greenfield except the cron unit files. **Installing the timer on velo-server = Hein (ops)**; enabling email = Hein |
| P5-5 | T10 variance commentary | touches `commentaryBudget.ts` (existing) → Hein reads the diff |
| P5-6 | T11 holders + slice workflow + reminders | the DB trigger rides in P5-1's migration or its own (Hein OK); Hein reads the diff (P1 approve path) |

Merge order: P5-1 → P5-2 → P5-3. Then P5-4, P5-5 and P5-6 run in parallel after P5-1. Each goes through `mq-isa add`.

## 9. Acceptance

On ISAFlow Demo (dev, then prod after an approved after-hours deploy, writes via the UI only):
- With policy `warn`, approving a bill over its cost-centre budget shows the remaining-budget table, demands a reason and records it in the audit log.
- With `block`, a manager is refused and an owner can override with a reason.
- An approved PO reduces remaining for the next bill, and that bill's own PO lines are not double counted.
- The daily run fires one 100% alert to the owner's bell and no duplicates on rerun.
- A variance note approved on BvA appears in the management pack's budget section and not in the share link's page-4 prose.
- A manager assigned to CC "Ops" edits only Ops, submits, and the owner returns then approves it.
- No email leaves the system.

## 10. Risks

| Risk | Mitigation |
|---|---|
| New lock in the AP approve path → 40P01 (history in `ap/.claude.md`) | lock only in block mode, taken first, bounded wait; T2 census; opposite-order bulk test |
| Default `warn` changes behaviour for every company with a budget | warn never refuses API callers; the UI asks for a reason only when over; release note; Hein confirms §0 |
| Committed figure wrong because PO ↔ bill linkage is sparse in real data | show committed as its own column so a user can see it; census Demo linkage before relying on it |
| `report_commentary` reuse leaks into packs or share links | `report_kind` filter census (T1) + the share-link test |
| Holder enforcement only in the API | DB trigger as app_user (memory: only DB-level checks hold) |
| Alerts noisy | thresholds per account, one alert per crossing, resolve on recovery |
| Timer never installed → alerts silently never run | the controls page shows "last evaluated at"; the handoff asks Hein to install the timer |
