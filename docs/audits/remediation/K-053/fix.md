# K-053 — aging and the AR/AP figures vs soft-deleted documents

**Trigger.** Soft-delete now reverses the document's approval journal. `reverseJournalEntry`
dates that reversal to TODAY whenever the document's own period is closed, so the control
account carries the document up to the delete and only then nets to zero. Any surface that
answers "is this document still in the ledger?" on a different clock — undated, or not at
all — disagrees with the GL at every as-at date in between.

**Before / after.** Before: the AR/AP figure surfaces either dropped a deleted document at
every date (`deleted_at IS NULL`) or carried it for ever (no predicate at all). After: each
asks `documentInLedgerAsAtFragment` at its OWN as-at date — the parity of the document's
reversal chain dated on or before that date — so it agrees with the control account, with
`arAgingService`/`apAgingService`, and with the close checklist, in both directions.

**Files.** 26 production files; see `fix-round7.md` for the census and the per-surface table,
`fix-round2.md`…`fix-round6.md` for the earlier rounds.

**Tests.** `tests/integration/k053*.int.test.ts` — 12 files / 59 tests, real PostgreSQL.
New this round: `k053-figure-surfaces-tie-to-gl.int.test.ts` (8 tests) reconciles every
newly-fixed surface against the control account at a date BEFORE the reversal and at TODAY,
using two documents: one deleted through the real service (reversal dated today) and one in
the pre-branch shape (`deleted_at` set, journal never reversed, GL still carrying it).
Mutation proof: 13 mutations, each turning one surface's dated fragment into the undated
`deleted_at IS NULL` or removing it; every one goes RED (`green.log`).
Full unit suite with `DATABASE_URL` unset: 9440 passed / 234 skipped, 793 files.
`bunx tsc --noEmit` clean; `bunx eslint` on every changed src/pages file clean.

**Migration / rollback.** Migration 653 (`soft_delete_journal_reversals`) from round 2;
nothing new this round. Rollback is a revert of the branch; no data is written by these
changes, which are all read-side predicates.

**Historical data.** No repair is needed and none is possible: the predicate answers
correctly for every population, including documents deleted before this change whose journal
was never reversed (parity 1, kept, exactly as the GL keeps them). Read-only impact SQL —
how many soft-deleted documents have a standing (never-reversed) approval journal, i.e. how
many the fixed surfaces will now KEEP that the undated predicate was dropping:

```sql
SELECT count(*) FROM customer_invoices ci
WHERE ci.deleted_at IS NOT NULL AND ci.gl_journal_entry_id IS NOT NULL
  AND (SELECT count(*) FROM gl_journal_entries je
       WHERE je.company_id = ci.company_id AND je.status = 'posted'
         AND (je.id = ci.gl_journal_entry_id OR je.reversal_of_id = ci.gl_journal_entry_id)) % 2 = 1;
```

## Disposition of the round-6 review

- **HIGH-1 — census scoped to the wrong population.** FIXED. The census was redone from the
  tables (137 readers of `customer_invoices`/`supplier_invoices`), not from the predicate;
  24 queries across 17 files were fixed, including both `reports-ar-aging` and
  `reports-ap-aging` legs and the three statement surfaces the reviewer named. Every
  exclusion is named with its reason in `fix-round7.md`. The reviewer's reproduction (R1,150
  AR / R2,300 AP against a zero GL) is now a passing assertion in both directions.
- **LOW-1 — dunning comments state a false invariant.** FIXED. Both comments no longer appeal
  to aging; `dunningCronService` carries the full reasoning, `dunningService` points at it.
  The behaviour is unchanged and still deliberately undated.
- **LOW-2 — the opening-balance line can misstate its own date.** FIXED as documented: the
  cost is now stated at the constant in `customerLedgerService`, including what an honest
  fix would cost (a dated "document removed" contra row) and why that is not this item.
- **LOW-3 — incomplete over-cap disclosure.** FIXED, and the list is now measured rather than
  recalled. Every file this branch touches that exceeds 300 lines, production and test:
  `gl/journalEntryPostingService.ts` (359), `ap/supplierInvoiceWorkflowService.ts` (516),
  `ar/dunningService.ts` (357), `pages/accounting/customers/[customerId].tsx` (359),
  `src/lib/mcp/contracts/figures.ts` (357); tests `gl/periodCloseReadinessService.test.ts`
  (867), `afs/noteGenerators/notes1to10.test.ts` (369), `notes11to20.test.ts` (329),
  `cashFlowForecastService.test.ts` (369), `dashboardStatsService.test.ts` (327), and three
  k053 integration files (402/417/447). None of them grew: every change in them is a
  one-line predicate, mock key or comment. ONE file did grow past the cap —
  `reports/disclosureNoteGenerators.ts`, 300 → 301 — and the extra line is the import the
  fix needs; splitting a file already exactly at the cap is an adjacent refactor.
  `ar/debtorsManagerService.ts` (300) and `reports/consolidatedReportingService.ts` (299)
  were brought back under it by shortening the comments this round added.
- **LOW-4 — one unreproduced parallel-run failure.** Not reproduced here either: the k053
  integration set was run repeatedly, serial and parallel, on a shared fixture database and
  passed 12/12 (59 tests) both ways. Recorded, not scored.
