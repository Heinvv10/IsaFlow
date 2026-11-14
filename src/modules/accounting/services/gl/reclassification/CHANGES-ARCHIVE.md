# CHANGES-ARCHIVE (frozen)

Frozen archive of the "Recent changes" sections that used to live in the sibling `.claude.md` file(s). Do not append to this file. Change history goes in commit messages and PR bodies; `.claude.md` holds rules only. CI (`check-no-recent-changes`) fails a PR that adds lines to an existing archive.

# Archived from .claude.md

## Recent changes
- 2026-10-12 (D4, PR #699): the legacy `cost_center_id` is no longer read (`candidates.ts`, `partition.ts`) or carried (`dimensions.ts`, `journals.ts`): no new journal line writes it. Both legs still carry project, CC1, CC2, BU and VAT coding.
- 2026-10-06 (ledger-date window, sec-numrace S2): `admitReclassification` refuses a `posting_date` outside 1900-01-01..2199-12-31 (planGuards, utils/journalDateWindow) before anything is written.

- 2026-09-10: CC1 and CC2 now travel through candidate mapping, ownership sanitisation and both reclassification journal legs, alongside the business unit. Lines carrying analysis coding are no longer skipped as `unreproducible_analysis_coding`; the shared writer's explicit `historical-copy` mode preserves owned inactive references while continuing to reject a foreign or wrong-slot reference.

- 2026-09-04 (review round): two HIGH defects closed. **HIGH-1**, the reversal
  pair split above — the first cut moved the reversing half of every pair whose
  other half it skipped. **HIGH-2**, no lock: two concurrent batches under
  different idempotency keys both posted. Closed with `FOR UPDATE` on the
  candidate lines following `bankTxLock.ts` — an advisory lock on the account
  was tried first and replaced, because the repo already owns this pattern and a
  second lock idiom in one module is how a third appears. Plus `vat_type` and `bu_id` now carried
  onto both legs, VAT control accounts refused, the dry run giving the identical
  refusal to the live call, `renderPeriods` echoing the caller's own
  `posting_date` rather than inferring one, `lock_timeout` on migration 600, and
  test coverage for `impact.ts` and for the `universeTotal` count.

- 2026-09-04: Built (migration 600). Verified read-only against the live Velocity
  books: `49775627 Unallocated Expense → 5100` proposes 414 of 419 lines,
  R11,318,214.27 gross / R10,503,370.05 net, 200 balanced journals, 5 skipped as
  `entry_reversed`, and changes NO P&L band. `49775626 Unallocated Income → 4100`
  proposes 70 of 109 — 39 of that account's lines sit on REVERSED entries.
