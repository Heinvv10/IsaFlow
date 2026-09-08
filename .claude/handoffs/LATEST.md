# Handoff — 2026-09-07 18:05 SAST

**Project:** IsaFlow
**Branch:** `master` (clean, in sync with origin, nothing unpushed)
**Session goal:** Work the eleven-defect connector brief at `~/Downloads/isaflow-dev-brief.md` (Velocity Fibre rebuild, 2–7 Sep) — verify each claim against the code, then fix the ones that are real.

## Status

Two PRs merged and **deployed to production**. Prod = master = `2f909043`, deployed 17:58 SAST, verified: `RELEASE_SHA` on the deploy dir matches, service active, `/api/health` returns `{"status":"ok","db":"ok"}`, post-deploy gate green (health + golden paths + integrity). Rollback snapshot at `/home/velo/isaflow-rollback` holds `9207fae5`.

Five brief items are closed. Three defects the reviews found that were **not** in the brief are also closed. The remaining brief items each need a decision or a bigger piece of work — none is half-done.

## What got done this session

**PR #338 — `9207fae5`** — bank allocation direction + CSV Reference column
- `allocateTransaction` computed `isSpent` and used it in 2 of 4 branches. `supplier` always posted DR AP / CR Bank, `customer` always DR Bank / CR AR. A supplier refund (money in) was booked as a payment out: bank wrong by 2x, call returns success, no unallocated line to find it by. **R261,651.64 on Velocity Fibre** across 5 lines.
- Three things rode on the sign and were each wrong on a refund: VAT account (a refund reverses INPUT tax; key now follows alloc type, only DR/CR follows sign), the 4-way match (gated on `isSpent`), and the `customer_payments` insert (gated on `!isSpent`).
- Apply path is **refused, not guessed**: `signMismatchReason` in `src/modules/accounting/services/bank/bankLineDirection.ts`, pre-write on all three surfaces.
- CSV `Reference` column now persists (`bankCsvParserGeneric.ts`), resolvable via `bank_reference`.

**PR #339 — `2f909043`** — bulk-create duplicate skip
- A repeated `(supplier_id, invoice_number)` is skipped, not a refusal of the whole call. A repeat must be **identical** (whole parsed element); same pair + any difference = refusal naming the differing fields.
- `flowQuantityFor` counts what will be created, not what was sent — skipped elements were being billed with no refund path.
- File split: `writeBulkInvoices.ts` 355 -> 208, plus `writeBulkCustomerInvoices.ts` (120) and `bulkInvoiceDuplicateSkip.ts` (142).

**Found by review, not in the brief — all fixed in #338/#339:**
1. `pages/api/accounting/bank-match-confirm.ts` — the sign fix *created* a regression here. Before, GL and subledger were both wrong in the same direction so they stayed equal; after, GL raises the AP liability while the route still reduces `amount_paid`, diverging by 2x. Now refuses pre-write (`withAuth` commits on a 4xx, so it must be pre-write).
2. `buildAutoCreateLines` (`bankRulesMatchingHelpers.ts`) — the **unattended rule sweep** had the identical sign defect, and the CSV Reference fix *activated* `match_field='reference'` rules that had never matched anything. The P1 half armed the P0 half.
3. `signMismatchReason` passed a zero line; `skipReasonForInvoice(state, id, 0)` runs `0 > 500.01` = false, so it was postable and threw mid-write, unwinding a whole 500-line batch.

## What's next

1. **FibreFlow procurement 403** (brief #4) — largest open item: R33.4m of PO bills, ~R29m wrong on AP, FY26 cannot close. Root cause found: `procurement` is on `MCP_DENIED_GROUPS` in `FF_Next.js/src/lib/auth/mcpDeniedAreas.ts:61`, a deliberate deny-list applied in `middleware.ts:226` before the handler. **Not a token/scope grant** — no permission gets past it and there is no per-path allow mechanism. Needs a code change in FF_Next.js plus Hein's decision (procurement was deny-listed on purpose).
2. **Brief #9 — bulk approve** — `bulk_approve_supplier_invoices` / `bulk_finalize_invoices` / `bulk_approve_credit_notes`. `approve_supplier_invoice` POSTS a journal (DR Expense + DR VAT / CR AP), so these are ledger-writing tools: per-element savepoints (see `bulkAllocationPost.ts`), skip-vs-throw partitioning, per-element metering. Run two reviewers from the start.
3. **Flaky CI gate** — `tests/unit/components/reports/reportPacksShareMount.test.tsx:110` aborted a production deploy. It waits for a button then assumes a fetch fired; `asked.find(...)!` returns undefined under load and `new URL(undefined, base)` does not throw, so it fails as `expected null to be 'board'` instead of "no call happened". One-line fix: `await waitFor(() => expect(asked.some(u => u.startsWith('/api/accounting/commentary?'))).toBe(true))` before the assertions. NOT done — it is the reporting workstream's file with WS4b in flight at `613c97e7`.
4. **Brief #6 — `search_gl`** still caps at 200 rows with no cursor. `general_ledger` (PR #309) covers the use case with a keyset cursor; cheapest fix is a cross-reference in `search_gl`'s description.

## Open questions / blockers

- **The R261,651.64 already in Velocity's books is uncorrected.** The deploy fixed what gets posted from here; it changed nothing historical. Needs the GL-vs-bank diff re-run on (date, signed amount) against prod, then a correcting journal. Hein said "dont worry about accounting issues now" — this is deliberately out of scope, not forgotten.
- Whether to fix the flaky reporting test (item 3) or hand it to the WS owner.
- Brief #8 (`posted_through` ~1h lag) **could not be reproduced**: `trial_balance` reads `gl_journal_lines` directly, no materialized view, no cache, and `posted_through` is `MAX(created_at)` of consumed rows. Needs a repro from the brief's author before it is worth chasing.

## Context the next session needs

- **Brief claims are not ground truth — two were wrong.** #10 said a `(supplier_id, invoice_number)` constraint rejected the batch: verified against the live schema, `supplier_invoices` has **no** unique index on invoice_number (only the PK) and `idx_supplier_invoices_duplicate_fp` is non-unique. The tool's own in-batch guard was the whole cause. #11 (deactivated-account error naming one account) was **already fixed** — `InactiveAccountError` lists all, ordered by code.
- **Run the adversarial reviewer on anything touching money.** Across two PRs the general reviewer approved and the adversarial reviewer found: money silently discarded, PAYG tenants billed for work never done, and the change's headline behaviour untested. Same diffs. The general reviewer verified every claim *made*; the adversarial one asked what the code fails to consider.
- **A guard fails in both directions.** #339's strict comparison (added to stop a wrong skip losing money) then wrongly refused `tax_rate` omitted vs `tax_rate: 15` — the same bill, since the service applies `?? 15`. Constant defaults are resolved via an imported constant (`src/modules/accounting/constants/supplierInvoiceDefaults.ts`, created for exactly this — do not restate `15`); computed defaults (`dueDate` from `calculateDueDate`) are deliberately NOT resolved.
- **`node_modules` was missing declared deps twice.** `echarts`, `@testing-library/*`, `happy-dom` (then `pptxgenjs` after merging master) were in `package.json` but absent, failing type-check/component-tests/build before any of this session's code was touched. `bun install` fixed it both times; lockfile unchanged.
- **`git status` hides untracked files** in this repo (`status.showUntrackedFiles=no`). Before a deploy, check with `git status -uall --short` — 75 untracked files were present, none in build paths.
- The deploy's CI gate runs **before** the build, migrations and rsync, so a gate failure touches production not at all. Confirmed live when the flaky test aborted the first attempt.
- `bun run agent-docs:generate` now emits **74** mirrors (was 60) after merging master.
- `.claude.md` "## Recent changes" has **no blank line** after the heading post-merge — an insert asserting on `"## Recent changes\n\n"` fails silently in a background job. Read the HEAD of background output, not just the tail.

## Git state

- **Uncommitted:** `.claude/handoffs/LATEST.md` — pre-existing at session start (another session copied `2026-09-06-1654.md` over it without committing). Not this session's.
- **Unpushed commits:** none
- **Stashes:** 3, all pre-existing and belonging to other work — `stash@{0}`/`stash@{1}` on `refactor/afs-validation-helpers`, `stash@{2}` on master. **Do not `git stash pop`** — `refs/stash` is shared across all worktrees (repo CLAUDE.md rule).
- **Background processes at teardown:** 0 `gh run watch`, 0 test-db containers. Live: a vitest fork in the `ws4-board` worktree (~11h, another session), a `next dev` on port 3471 in a scratchpad worktree (~7.8h), and FF_Next.js CI runners (different repo). None in this checkout — nothing to kill for this session.
- **27 worktrees** registered. Nothing in this session used one.

## Where to resume

Read this file, then pick one:
- FibreFlow scope decision: `FF_Next.js/src/lib/auth/mcpDeniedAreas.ts:61` (remove `procurement` from the group, or add a per-path allow for `/api/procurement/purchase-orders` + `/grn`).
- Bulk approve: model on `src/lib/mcp/tools/writeSupplierInvoices.ts:129` (`approveSupplierInvoiceTool`) and `src/lib/mcp/tools/bulkAllocationPost.ts` for the per-line savepoint pattern.
