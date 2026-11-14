# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-26 (P1, migration 947): module created.
- 2026-11-03 (P3 follow-up LB-2(b), #1124): `primaryVersionScopeAndYears` owner rule, whatever day the window starts: a month belongs to the stored year holding its 1st (as `budget_primary_month_amounts` and year-end rehoming file it). The one exception: a template year's mid-month last month goes to the following year only when that year is stored. Where no stored year holds the 1st, master's walk holds. `trackingRange` judges the version/absent checks on the owning years. Byte-identical where every year starts on the 1st (fuzz vs master in `budgetVersionScopeLb2bAdversarial.test.ts`). Known limitation (master too): a window from the 1st of a month whose 1st is in a registry gap is a 400.
- 2026-10-26 (P2 PR-B): grid read model, prior actuals, batch save, seed wizard, Excel template + import preview; decision 18 refusal in `upsertBudget`.
- 2026-10-27 (P2 PR-B fix, found in the PR-D browser proof): the no-version read returns the accounts (it answered `accounts: []`, so the budgets page said "No revenue or expense accounts" instead of offering the wizard).
- 2026-10-27 (P2 PR-D review): `GridAccount.note` (read-only budget notes on the grid).
- 2026-10-28 (P2 follow-ups F1/F2): `budgetNotes.ts` (editable year-scoped notes, notes carried by cross-year seeds); lineage on every version seed (`createVersion(…, basedOn)`).
- 2026-10-29 (P4 PR-3): `takeVersion` + `BudgetVersionStaleError` moved unchanged to `versionTake.ts` (the driver writes share the compare-and-set; `gridSave` re-exports the error). `saveCells` keeps closed months and 'actual' cells read-only, refuses clearing a driver-computed cell, treats an override clear as a reset, marks a typed change in a driver range 'override', and recomputes the version's drivers once per changed batch, answering `recomputed`, `reset`, `driverWarnings` (`drivers/.claude.md`); grid cells carry `source`, the read model `drivers`.
- 2026-11-04 (P5-6 r6): reopen an approved slice (approved → returned), DB rule, route, Reopen button.
- 2026-11-03 (P5-6 r5): override reset in a frozen slice refused; roll counts under-review apart from outside-the-holder's-slices.
- 2026-11-03 (P5-6 r4): frozen slices for driver recomputes, per-slice reviewer path, roll keeps the month stale while it leaves cells and re-rolls on a return.
- 2026-11-03 (P5-6 r3): 955 rewritten for write integrity (statement-level amounts check, driver lines, planned hires, version approve gate, move-changes-nothing-else, locked slice keeps holders, company-delete cascade); roll/rehome slice-aware; holder view documented as work scope.
- 2026-11-03 (P5-6 r2): holder scope on template / import preview / prior actuals, unassign, account-limit UI, driver recompute guard (409 BUDGET_SLICE_DRIVER), budget routes moved to `src/lib/apiRoutesBudgets.ts`.
- 2026-11-03 (P5-6): migration 955 (holder slice guard, holder and slice-review rules), budget holders, the slice review workflow, holder mode in the grid read and save, version approve gated on slices (owner force with a reason), reminders + cron.
- 2026-11-02 (P5-1 review r2): session-stamped actors/times, member-only notification recipients, href control chars refused, event documents checked, committed netted at the posted ex-VAT amount.
- 2026-11-04 (P5-2b): block refuses off-slice lines (see "P5 controls (P5-2)"); round 2: system wording, writers keep dimensions, provisional inheritance.
- 2026-11-03 (P5-3): the budget check at PO approval (`ap/purchaseOrderApprove.ts`, `ap/purchaseOrderBudget.ts`), the PO preview mode of `/budgets/remaining`.
- 2026-11-03 (P5-2): the budget check at bill approval (`budgetCheck*.ts`, `ap/supplierInvoiceBudgetCheck.ts`), the bill preview modes of `/budgets/remaining`.
- 2026-11-02 (P5-1): migration 954 (controls schema), `remainingBudget.ts` + `remainingBudgetCore.ts`, `POST /api/accounting/budgets/remaining`.
- 2026-11-03 (P5-4): overspend alerts (`overspendAlerts*.ts`), daily cron + timer files, Evaluate now, controls/threshold routes and page, email digest (off), "last evaluated" in `accounting_settings`; `remainingForKeys` split out of `remainingFor`.
- 2026-11-03 (P5-4 review r2): email flag rule (only false→true refused), cron 500 on a failed company, last evaluated per source, digest send in a company-context tx, controls writes rate-limited, summary key per run, inactive/suspended owners/admins not notified.
- 2026-11-03 (P5-4 review r3): digest SMTP outside any transaction, per-email log transaction and per-send failure count; `emailService.logEmailAttempt` exported.
- 2026-11-03 (P5-5): variance notes (see "P5 variance notes").
