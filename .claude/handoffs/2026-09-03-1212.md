# Handoff — 2026-09-03 12:12 SAST

**Project:** IsaFlow (`/home/hein/Workspace/IsaFlow`)
**Branch:** `fix/reporting-p0-round2` @ `387bd061` — pushed, 0 unpushed. Stacked on `fix/afs-p0` @ `79e2e80d`+ (PR #303).
**Session goal:** Fix the remaining reporting P0s from the 2026-09-03 audit (AFS, AR/AP, consolidation, exports, inventory/assets).

## Status

Two PRs are open and **both are waiting on Hein**. Neither is merged, neither is deployed. Everything still unfinished is blocked on a decision, not on effort.

- **PR #303** -> `master`, 15 commits. AFS (all 6 P0s), AR/AP aging due-date, customer statement, consolidation sign inversion, report-pack zeros, asset disposal. Two independent blind reviews, all findings fixed.
- **PR #306** -> `fix/afs-p0`, 12 commits. Point-in-time AR/AP aging. Four review rounds. **Merge #303 first** — #306's base is that branch.

Deploy was never attempted: the session ran 06:20–12:12 SAST, entirely inside the 08:00–17:00 Mon–Fri production block.

## What got done this session

Verified every numeric claim against **production** read-only before coding. Several audit figures were wrong; corrections are in the commit messages.

**AFS (PR #303)**
- `1f1cad8c` cash flow — fan-out (audit said 20x, it is **2x**; company `4a159669` reported net cash **-R9,089,506.51** vs a true **+R381,207.22**) plus a second defect the audit missed: classification matched subtype spellings that barely exist, so **4,650 of 6,341** contra lines fell into the catch-all.
- `60741392` changes in equity — profit was invented from posting signs; opening dropped accumulated profit.
- `79e2e80d` fiscal year — `fiscalRange()` was Jan–Dec in **four** copies, not one (incl. the prior-year comparatives).
- `9a355b76` the six headline totals (migration **533**) + export blockers that structurally could not fail + new AFS-to-ledger tie-out.
- `aba3d62e` first blind review: seeder never wrote `total_basis`; tie-out counted a mapping row without resolving it; cash blocker compared two different definitions of cash.
- `58f4d500` second review: `IS485` "Accumulated income end of year" showed only the current year.

**AR/AP + others (PR #303)**
- `75cfec1f` aging dropped every invoice with no due date — **AR R13,908,380.43** (34), **AP R37,703,816.94** (357, = 33% of open payables).
- `5f7ac6ba` customer statement billed **130 drafts (R5,555,315.66)** + 58 cancelled, and omitted **93 credit notes (R372,634.32)**.
- `99107ff0` report pack had **four** hardcoded zeros (audit said two) and classified current assets by account-code range.
- `575234b7` consolidation: a R100 elimination moved group profit by R200 (verified empirically).
- `fbfed185` asset disposal posted no GL journal. **Live**: prod has 1 disposal, R8,000, `journal_entry_id` NULL.

**Point-in-time aging (PR #306)** — three designs, two wrong. See "Context" below.

## What's next

1. **Merge #303, then #306.** Both need Hein reading the diff — this modifies live customer-facing reporting, so it fails the CLAUDE.md autonomy boundary on 3 of 5 conditions.
2. Deploy **after 17:00 SAST** from a clean detached worktree at the merge commit (`deploy.sh` builds the CURRENT tree at current HEAD; it does NOT fetch master).
3. Migrations to apply: **533** (afs_statement_lines total_basis/components) and **535** (two credit_notes invoice indexes). Both idempotent, both re-applied on dev.
4. Then the blocked items below, in whatever order Hein decides.

## Open questions / blockers

All of these are Hein's calls. None can be resolved from the code.

- **AR/AP control account (blocks task 2a).** A control-account reconciliation needs the AR control account named. 13 accounts carry `subtype='receivable'`, one carries NULL; two reasonable queries give two answers. The MCP figure registry deliberately leaves `ar.control.v1` / `ap.control.v1` UNOWNED for this reason.
- **Non-controlling interest (3a).** The schema cannot distinguish subsidiary from associate, and IFRS treats them differently (consolidate 100% + show NCI, vs equity method). All 3 prod group members are at 100%, so NCI is arithmetically inert today. Implementing it means guessing which.
- **Inventory (5a).** TWO parallel inventory models. `stock_items` and `items` are **0 rows** globally; `stock_movements` (240 rows, all `purchase`, all demo company) belongs to a different subsystem (`products`/`warehouses`). Wiring movements into `stock_items` means building on whichever model Hein has not chosen. Also: `stock_movements` has **no `company_id` column at all**.
- **The R8,000 disposal with no journal.** Correcting it writes to a client ledger.
- **`packDeliveryService`** emails packs with `skipChecks: true` and no watermark, bypassing the export blockers. Outbound customer communication.
- **8 production expense accounts** named salary/wage/payroll are subtyped `operating_expense` or NULL, so they classify as payments to suppliers. Fixed the *vocabulary* (`payroll_expense` canonical subtype); deliberately did NOT name-match, because that is the defect class #300 removed. Their subtype needs setting — a data change.

## Context the next session needs

**Point-in-time aging was wrong twice before it was right.** Read `src/modules/accounting/services/shared/agingRewind.ts` before touching it — the formula, the census and all four limitations live there.

1. *Rebuild-from-zero* (abandoned): reconstructed paid amounts from allocation history. Assumes every settlement leaves a dated trail. It does not — invoices settled by an untracked path **reappeared at full face value as delinquent debt** (105 invoices for one client on dev).
2. *Anchored, unguarded* (abandoned): fixed that, then post-dated payments were rewound on the **default** report (one company's AP aging moved R7,241,000.56 -> R7,623,216.94 with no `as_at` supplied), and rewinding could exceed the anchor (a supplier aged R50,275.55 on a R38,614.57 invoice).
3. *Current*: anchored + two-sided clamp + rewind window bounded at today from ONE clock.

**Unallocated receipts are the norm, not the exception** — 36/58 on Velocity (R37,050,347.68), 37/37 on Brightsphere (R2,691,024.00). This is why anchoring beats rebuilding, and why "allocations reconcile to amount_paid" is a **false** premise (an earlier measurement of mine appeared to confirm it because both sides read zero and agreed trivially).

**`bank-match-confirm.ts` writes `amount_paid` ABSOLUTELY**, clobbering what the allocation paths accumulated while their allocation rows survive. This is the root cause of the two ledgers disagreeing at all — dated settlement exceeds `amount_paid` on 40 production invoices by R124,960.37. **A live settlement-path defect, independent of any report.** Ranked highest of the un-actioned findings.

**The year-end close still cannot post.** `yearEndService` writes `source = 'year_end'`, which `gl_journal_entries_source_check` rejects with 23514 (proved on dev in a rolled-back transaction). PR #304 (parallel session) fixed a *different* year-end defect — a 42703 undefined column. Verified on master: `year_end` is still absent from `GL_ENTRY_SOURCES` and no migration added it.

**`fiscal_periods` are seeded Jan–Dec for all 12 companies regardless of `companies.financial_year_start`** (which is 3 for all 13 — the unset column default). Hein ruled the *settings* value authoritative, so AFS now follows it. Period *closing* still follows the periods table. The two disagree; unresolved.

**Census counts were wrong FIVE times this session** (`amount_paid` writers). The final one is in `agingRewind.ts` and explicitly tells the reader to re-derive rather than trust it. A census built from the service layer misses route handlers, webhooks, scripts and importers.

**Entity-total assertions swallow defects.** Four tests passed on broken code — including the test *guarding the clamp*, which bounded an entity total loosely enough that the unclamped value sat inside it. Assert on a single invoice via the drill-down, not on a total.

**Three self-inflicted tooling traps, all repeated:**
- A backtick OR `${...}` inside a SQL comment in a `sql` tagged template. Backticks fail at build time; interpolations fail at RUNTIME with `42P18 could not determine data type of parameter $1`, naming a parameter unrelated to the comment. Guarded by `tests/unit/ci/noBacktickInSqlComment.test.ts` (hit 3x before the guard).
- `python replace-in-a-while-loop` where the replacement text re-matches the search pattern -> infinite loop (hit 3x). Do it in one pass.
- `git checkout -- <file>` on a file with uncommitted work destroyed the clamp + date bound + comment. Use a `cp` backup for mutation testing, never `git checkout`.

**DO NOT RESURRECT:**
- **Migration 534 (`534_gl_source_year_end.sql`), which added `'year_end'` to `gl_journal_entries_source_check`.** Written, applied to dev, then REVERTED and deleted. `tests/unit/services/glEntrySourceConstraint.test.ts` exists precisely to catch this and did. The constraint is the ONLY guard on an unvalidated INSERT-at-posted path that moves a whole year's profit — `yearEndService` inserts straight to `status='posted'` without `validateJournalEntry`, and `trg_gl_je_balanced` is BEFORE UPDATE only. Convert the writer to `createJournalEntry`/`postJournalEntry` FIRST, then admit the source.
- **Rebuilding point-in-time paid amounts from allocation history.** Looks like the obvious design; resurrects settled invoices as delinquent debt. See above.
- **Using `customer_invoices.paid_at` to date the undated settlement remainder.** It is 100% populated on one prod company and looks usable. It marks when an invoice became FULLY paid, so attributing the whole remainder to it asserts nothing was paid earlier — on an invoice with part-payments that INVENTS a delinquency.
- **Weighting the cash-flow apportionment by `Math.abs(amount)`.** Wrong for every mixed-sign entry (i.e. every payroll run): put -R53,846.15 of a R70,000 payroll on "cash paid to suppliers". Signed weights.

**Verification baseline at handoff:** 593 unit files / 7036 tests pass serially (`bunx vitest run --no-file-parallelism`), 38 DB-backed AR/AP integration tests, typecheck clean, lint 0 errors (6 warnings, all pre-existing in `creditNoteApproveService`/`creditNoteCancelService`, untouched by these branches).

**8 integration test files always fail locally** — `2fa-*`, `csrf`, `csp-headers`, `zod-validation`, `impersonation-flow`, `admin-reset-2fa`. Cause is `Dev server not reachable at http://localhost:3200`, not the code. Pre-existing.

## Git state

- **Uncommitted:** `.claude/handoffs/LATEST.md` only (this handoff overwrote it; the prior content is archived at `.claude/handoffs/2026-09-03-0620.md`, untracked but on disk).
- **Unpushed commits:** none. Both branches pushed.
- **Stashes:** 5, all pre-existing from other sessions (`refactor/afs-validation-helpers` x2, `master` x2, `audit/p1-schema-validation-afs` x1). **None are mine. Do not pop blindly** — `stash push -- <path>` makes no entry when the path is clean, so a paired bare `pop` grabs another session's `stash@{0}`.

## Session teardown

Background processes still running (**reported, not killed**):
- PIDs `74951` / `76504` / `76510` — `next dev` for **CrestaHQ**, a different project. Not ours.
- PIDs `258500` / `258503` — a `next build && next start` walkthrough capture on port 3006. Not ours.
- Docker `setup-test-db-1`, up 26h (healthy).
- **14 git worktrees open.** 8 belong to the parallel MCP session (`w0`-`w6`, `fix-audit-silent-failures`), plus `IsaFlow-deployfix`, `IsaFlow-vat-fix`, `IsaFlow_wt/bankcol`, `IsaFlow_wt/deploy-a2bb7ff7`.

**A parallel session (`isaflow-bf`) is active on this repo.** It owns migration prefixes **540-609** and merged PRs #301, #302, #304, #305 during this session. Master moved three times; both my branches were rebased onto it. My prefixes 533/535 do not collide.

## Where to resume

Read this file, then:

```bash
git fetch origin && gh pr view 303 --json state,mergeable
gh pr view 306 --json state,baseRefName
```

If both still open: the next action is Hein reading #303. If #303 has merged, rebase `fix/reporting-p0-round2` onto master and retarget #306.
