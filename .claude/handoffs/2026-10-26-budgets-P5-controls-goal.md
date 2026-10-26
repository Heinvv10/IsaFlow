# /goal — Budgets P5: controls & collaboration (budget check at approval, overspend alerts, variance commentary, budget holders)

> **How to use:** start a fresh session **on Opus** in `/home/hein/Workspace/IsaFlow` and run:
>
> `/goal Execute .claude/handoffs/2026-10-26-budgets-P5-controls-goal.md to completion. Answer §0 with Hein first, then work autonomously through Census → Lock-order census → TDD (red) → Build → Review → Fix loops, one PR at a time in the §8 order. Do not stop to ask, except at a Confirmation Gate (§9) or a genuine external blocker. Loop until every Success Criterion (§7) is proven with evidence, queue each PR with mq-isa, write a handoff and stop.`

**Precondition:** P1, P2 and P3 merged to `origin/master` and live on ISAFlow Demo. Check (contract "Preconditions"): `git ls-tree -r --name-only origin/master | grep -F -e src/modules/accounting/services/budgets/budgetVersionScope.ts -e src/modules/accounting/services/budgets/gridSave.ts -e src/modules/accounting/services/budgets/tracking/trackingActualRead.ts -e src/components/accounting/budgets/tracking/useBudgetTracking.ts -e tests/unit/services/afs/managementPackComparisonMode.test.ts` lists all five; "live on Demo" = the handoff of the last P1–P3 deploy names a deployed SHA containing them. If not, STOP and report.

**Before executing:** refresh this file and `docs/plans/budgets/P5-controls-spec.md` against the MVP feedback Hein
and Willie gave on P0–P3. Fix every P1–P3 name below to what actually shipped (`git ls-files | grep -F`).
The spec is the design. This file is the contract.

## §0 Phase-start decision gate (FIRST action: put these to Hein in one AskUserQuestion; record the answers here)

| # | Decision | Pre-filled default | Hein |
|---|----------|--------------------|------|
| 8 | Budget check at supplier-invoice / PO approval | Per-company `off \| warn \| block`, default **warn**. **warn**: a UI approver must give a reason when over; bulk/MCP proceed with `warnings` + an audit row `no_reason`. **block**: refused 409 `BUDGET_EXCEEDED`; owner/admin may override a single approve with a mandatory reason; bulk/MCP cannot override. A slice with no budget row is never blocked; a zero budget is a budget. | yes / override |
| 8a | Remaining = budget − posted actuals − open approved-PO commitments (less linked bill items); a bill excludes its own PO lines | as stated | yes / override |
| 8b | Month: bill `invoice_date`, PO `order_date` | as stated | yes / override |
| 8c | PO gets a real Approve action; the PUT stops accepting `status='approved'` | as stated | yes / override |
| 9 | Overspend alerts: in-app to owner+admin, daily scheduled run + "Evaluate now", thresholds 80/100/120% overridable per account/slice; email digest built, **off** (company flag false + env `BUDGET_ALERT_EMAIL_ENABLED` unset) until Hein enables | as stated | yes / override |
| 9a | Budget holders: role manager+, edit only own slice on a draft version; version approve needs all slices approved unless the owner forces it with a reason | as stated | yes / override |

## §1 Mission

Ship the controls that only an in-ledger budget can offer, without adding a deadlock or a silent bypass to the AP money path.
1. A budget check at the moment a supplier invoice or PO is approved.
2. Overspend alerts.
3. Variance commentary that reaches packs.
4. Budget-holder workspaces.

"Real" means:
- A real-PG integration test for every rule, each red under a named mutation of production code.
- A real-PG race test proving block mode cannot be beaten by two concurrent approvals.
- A Playwright golden path with a screenshot on ISAFlow Demo (dev).

No mocked SQL in the evidence.

## §2 What exists — do NOT redo (verified on origin/master 37992605a)

- **Bill approval:** `src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts`.
  - `approveInner`: invoice lock (`supplierInvoiceLock.ts`) → `assertBillApprovable` (`billPostingGuard.ts`) → journal → status UPDATE. It already returns `warnings`.
  - `postToGLInner` posts drafts without approval. That is the bypass to close.
- **Callers:**
  - Routes: `pages/api/accounting/supplier-invoices-action.ts`, `pages/api/accounting/supplier-invoices-bulk-action.ts` (one transaction, a savepoint per item).
  - MCP: `src/lib/mcp/tools/writeSupplierInvoices.ts`, `src/lib/mcp/tools/writeBulkApproveSupplierInvoices.ts`.
  - System: `src/modules/accounting/services/capture/provisionalAttachSettle.ts`, `src/modules/accounting/services/core/recurringTransactionInvoices.ts`.
- **Lock history and AP guard suites:** `src/modules/accounting/services/ap/.claude.md`. Read it fully before T2.
- **Bounded lock wait:** `src/modules/accounting/services/core/rowLockBudget.ts`.
- **Dimensions on bill lines:** `scripts/migrations/sql/870_dimensions_cc_bu_capture.sql` (`supplier_invoice_items.cc1_id/cc2_id/bu_id`; tables `cost_centres`, `business_units`).
- **POs (live schema):**
  - Schema: `scripts/migrations/sql/246b_purchase_orders.sql`.
  - Code: `pages/api/accounting/purchase-orders/[id].ts` (PUT sets status), `pages/api/accounting/purchase-orders.ts`, `pages/api/accounting/purchase-orders/unmatched.ts`, `pages/accounting/purchase-orders/[poId].tsx` (status select), `src/modules/accounting/services/ap/goodsReceivedService.ts`.
  - **Gaps:** no approve action, `approved_by` never stamped, `po_items` has no dims, `quantity_invoiced` never written.
  - `supplier_purchase_orders` (mig 247) is out of scope.
- **Alert patterns:** `scripts/migrations/sql/345_compliance_alerts.sql`, `src/modules/accounting/services/afs/complianceAlertService.ts`.
- **No per-user notification store and no header bell exist.** Header: `src/components/layout/AppLayout.tsx`, `src/components/layout/MobileHeaderMenu.tsx`. The count badge beside Search in prod (e.g. "13") is `src/components/onboarding/SetupGuideButton.tsx` (remaining setup tasks from `/api/accounting/setup-guide` + a user preference): not a store, not reusable; keep the new bell visually distinct from it.
- **Email:**
  - Sender: `src/modules/accounting/services/core/emailService.ts`.
  - Digest pattern: `src/modules/accounting/services/practice/practiceNotificationService.ts`, `src/lib/email-templates-practice-digest.ts`.
  - Send-flag pattern: `pages/api/cron/expectations-daily.ts` (`chase_auto_send_enabled`).
  - Timers: `scripts/isaflow-expectations.timer` / `.service`.
- **Commentary:**
  - Code: `src/modules/accounting/services/commentary/{commentaryService,commentaryApprove,commentaryState,commentaryLimits,commentaryBudget}.ts`, `src/components/accounting/commentary/{CommentaryEditor,CommentaryBlock}.tsx`.
  - Pack readers: `src/modules/accounting/services/packs/pages/packDraftState.ts`, `src/modules/accounting/services/share/sharedPackService.ts`, `src/modules/accounting/services/reports/packParamsHash.ts`.
  - **Trap:** `commentaryBudget.printsOnFixedPage` charges any non-pack-hash row against the page-4 budget.
- **Roles:** `src/lib/auth/types.ts`, `src/lib/auth/writeRoles.ts`, `src/lib/auth/permissionService.ts` (no dimension scope), `src/modules/accounting/services/reports/sharingAccess.ts`.
- **Audit:** `src/modules/accounting/services/core/auditTrailService.ts` (`logAuditOrThrow`). The `budget` filter is already in `pages/accounting/audit-log.tsx`.
- **Approval gate (separate control, do not merge with it):** `src/modules/accounting/services/gl/approvalGate.ts`.
- **Colours:** `src/components/accounting/charts/ibcs.ts`. Nav: `src/components/accounting/accountingNavConfig.ts`.
- **From P1–P3 (names from their specs; confirm at refresh):** P1 `budget_versions`, `budget_month_amounts.version_id/cc1_id/cc2_id/bu_id`, lock trigger `public.budget_month_amounts_refuse_locked()`, `src/modules/accounting/services/budgets/` + `.claude.md`, `budgetVersionStatus.ts` `transitionVersion`; P2 `budgets/gridSave.ts`, `src/components/accounting/budgets/workspace/`; P3 `budgets/tracking/trackingActualRead.ts`, `src/components/accounting/budgets/tracking/`, the management-pack `budget_variance` section in `src/modules/accounting/services/afs/managementPackGeneratorService.ts`.

## §2a Product decisions already made (contract — do not re-ask)

Contract decisions 1–6 stand: approve/lock = owner + admin; unlock = owner with reason; locked = immutable at the DB; one grain per account per version; readers use the primary version; prod writes only into ISAFlow Demo via the UI. §0 answers are added here once Hein gives them.

## §3 Budget check at approval [Confirmation Gate: money workflow]

- NEW `src/modules/accounting/services/budgets/remainingBudget.ts` and NEW `src/modules/accounting/services/budgets/budgetCheck.ts`, per spec §3a–3b.
  - Actuals come from P3's `budgets/tracking/trackingActualRead.ts`, never a second formula.
  - Committed is derived from `po_item_id` linkage.
- **Wiring:**
  - The check runs under the document lock, before the first write, in `approveInner` (after `assertBillApprovable`), in `postToGLInner`, and in the NEW PO approve.
  - Routes take `budgetReason` / `budgetOverride` (zod).
  - MCP returns `budget_warnings`; block refusals are typed.
  - Every outcome writes `budget_check_events` (INSERT-only for app pools) plus `logAuditOrThrow` entity `budget`.
- **Concurrency** [agent decides only within this frame]:
  - warn takes no lock.
  - block takes ONE per-company transaction advisory lock FIRST (before the invoice `FOR UPDATE`), with a bounded wait (→ 503 retryable). The policy is re-read under the lock. Bulk/MCP-bulk take it once before their loop.
  - **Before writing any lock code, produce the lock-order census (spec T2)** for every caller in §2, including the locks a caller already holds.
  - A caller that cannot take the lock first gets the documented lock-free fallback, written down as a known limit.
  - Do NOT add per-key locks inside approve. They accumulate across a bulk transaction and deadlock in opposite order.
- **PO:** NEW `pages/api/accounting/purchase-orders/[id]/approve.ts`. `po_items` gains dims. The PUT refuses `approved`. The PO page gets an Approve button and dimension pickers.
- **UI:** a remaining-budget panel in the bill approve dialog (`pages/accounting/supplier-invoices/[invoiceId].tsx`), the bulk reason modal, and the PO detail page.

## §4 Overspend alerts + notifications

- **Store:** NEW tables `budget_control_settings`, `budget_alert_thresholds`, `budget_alerts`, `user_notifications` (spec §2).
- **Bell:** NEW `src/components/layout/NotificationBell.tsx`, mounted in `AppLayout.tsx` and `MobileHeaderMenu.tsx`.
- **Evaluation:** NEW `src/modules/accounting/services/budgets/overspendAlerts.ts`.
  - Dedupe by the unique key with `ON CONFLICT DO NOTHING`; notify only on a new row; resolve on recovery.
  - Triggers: NEW `pages/api/cron/budget-alerts.ts` (`X-Cron-Secret`) and NEW `POST /api/accounting/budgets/alerts/evaluate`.
  - NOT on posting (spec §3d gives the reason).
- **Timer files:** NEW `scripts/isaflow-budget-alerts.timer` / `.service` are committed. Installing them is Hein's ops act: never done by this session; list it in the handoff.
- **Email digest:** NEW `src/modules/accounting/services/budgets/overspendDigest.ts` + NEW `src/lib/email-templates-budget-digest.ts`. Built and tested; sends only when both flags are set; neither is set by this goal.

## §5 Variance commentary [agent decides details; Hein reads the commentaryBudget diff]

- **Reuse:** `report_commentary` with `report_kind='budget_variance'` and the filing key from spec §3e. NEW server-only hash helper.
- **Write path:** NEW `src/modules/accounting/services/commentary/varianceCommentary.ts`; approval is the existing `approveCommentary`.
- **Scoping fix:** `printsOnFixedPage` is scoped to `report_kind='pack'`.
- **Surfaces:** the P3 BvA (`src/components/accounting/budgets/tracking/`) shows the note popover. P3's management-pack `budget_variance` section is extended (not rebuilt) to print approved notes only. The share link never shows them.

## §6 Budget-holder workspaces

- **Store:** NEW `budget_holders` and `budget_slice_reviews`.
- **Rules:**
  - ONE transition function: NEW `src/modules/accounting/services/budgets/sliceReviewState.ts`.
  - The WHERE repeats the from-state.
  - A DB trigger refuses holder writes outside their slice or on a submitted/approved slice. Any SECURITY DEFINER helper needs an `app_definer_reviews` row (mig 930 registry).
- **UI:**
  - Holder mode of the P2 grid.
  - NEW `pages/accounting/budgets/review.tsx` and NEW `pages/accounting/budgets/controls.tsx`, both added to the nav config.
  - Due dates; in-app reminders at −3 days, due and overdue, from the same cron.
- **Version approve** is refused with unapproved slices unless the owner forces it with a reason.

## §7 Success criteria (all with evidence in the PR bodies; artefacts in `/home/hein/.cache/redchk/budgets-p5/`, never `/tmp`)

- [ ] §0 answered by Hein and recorded in §2a.
- [ ] T1 census and T2 lock-order census tables in the P5-2 PR body.
- [ ] Every test in spec §7 committed, green on the branch, red under its named mutation (log paths in the PR body).
- [ ] Block race: two concurrent approvals → exactly one refused. Lock mutated out → both approve (red).
- [ ] Two bulk runs in opposite order → no 40P01, no 5xx, 5/5 runs.
- [ ] Every AP guard suite named in `ap/.claude.md` still green.
- [ ] RLS and app_user tests for every new table. `budget_check_events` refuses UPDATE/DELETE.
- [ ] No outbound email in any test or run. The send function is asserted not called with the flags unset.
- [ ] `bun run ci` green, and the GitHub integration job green, for each PR.
- [ ] Blind `/review` + security review SHIP on each final head, with every H/M/L fixed. P5-2 and P5-3 also get a fresh adversarial breaker with real-PG repros on its own cluster, and it SHIPs.
- [ ] Playwright `tests/e2e/golden-paths/<next free letter>-budgets-controls.spec.ts` (NEW) green on dev with a screenshot, and listed in `playwright-golden.config.ts`'s `testIgnore` regex (dev-only: it flips the policy and posts bills; contract golden-spec rule). Browser proof dark + light at 1280 and 390 px on ISAFlow Demo (dev).
- [ ] `.claude.md` updated (`budgets/`, `ap/`, `commentary/`, `purchase-orders/`) and `bun run agent-docs:generate` run.
- [ ] Each PR queued with `mq-isa add <N>` only after its gates in §9. Handoff written; worktree and clusters cleaned.

## §8 PR order

1. **P5-1:** migration + `remainingBudget` + notifications + bell.
2. **P5-2:** bill-approval check.
3. **P5-3:** PO approve.
4. **P5-4, P5-5, P5-6:** alerts/cron/digest, variance commentary, holders. These run in parallel after P5-1.

One PR in flight per interacting area. Merge only via the queue.

## §9 Confirmation gates — STOP and ask Hein (the contract's human gates, nothing else)

- §0 decisions, before T1.
- The P5 migration (and any separate holder-trigger migration), before merge.
- **P5-2 and P5-3 modify a money workflow:** Hein reads the diff AND an adversarial review SHIPs before `mq-isa add`.
- Every other PR that modifies existing production code (`AppLayout.tsx`, `commentaryBudget.ts`, the PO PUT, P1's `transitionVersion`): Hein reads the diff.
- Enabling any email, or any message to a real person.
- Any read or write of production or non-Demo data, and any deploy. The goal never runs `bash scripts/deploy.sh`; it hands Hein the after-hours request.

**Never do (not gates; put them in the handoff):** install the systemd timer on velo-server (ops work: Hein's act). A caller that cannot take the company lock first gets the documented lock-free fallback; write the residual race and the options into the P5-2 PR body for Hein's diff read. If review rounds keep surfacing a new lock cycle, scope back to the spec and say so in the PR body.

## Rules (repo law, from CLAUDE.md and the contract)

- **Worktree:** `git worktree add -b feat/budgets-p5-<part>-<date> /home/hein/Workspace/IsaFlow-budgets-p5 origin/master`. Link `node_modules` with `cp -al` (never `ln -s`). `cd` into the worktree on every Bash call.
- **Code:**
  - `company_id` on every query; the `sql` tagged template from `@/lib/neon`; `withAuth(withErrorHandler(...))`; `apiResponse`.
  - `log`, not console; no empty catch; ≤300 lines per file; TDD.
- **Migrations:** `IF NOT EXISTS`. Use the next free 3-digit prefix **at commit time** (no hardcoded prefix; P1/P4 will have taken some). Never edit an applied migration.
- **Display:**
  - Money via `formatMoney` (statements: `formatStatementFigure` / `formatPct`).
  - Fav/unfav colour only via `ibcs.varianceColor`.
  - Tooltips via `escapeHtml.ts`.
- **Git:**
  - Stage explicit paths. No `git add -A`, no stash, no `--no-verify`, no amend or force-push.
  - Push at load < 25, in the background.
  - Merges only via `mq-isa add`.
- **Process:**
  - Dev DB is `isaflow_dev`; integration tests use disposable clusters.
  - Do not edit the tree while a gate run is in flight. No pattern kills. Subagents never edit memory.
