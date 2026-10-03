# R-186: the archive skips customer invoices a Paystack or Stitch request references

## Defect

`executeArchive` deleted every paid or cancelled customer invoice dated before the cutoff.
`paystack_payment_requests.customer_invoice_id` is `ON DELETE SET NULL`, and
`paystack_pr_invoice_has_invoice` requires it for purpose `customer_invoice`. So deleting an
invoice such a request references raised 23514, and the whole run rolled back to its savepoint
(`red.int.log`: `executeArchive threw 23514 ... paystack_pr_invoice_has_invoice`).

## Decision

Goal file `.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`, §2a item 5 and §4. The
goal file marks this item "default, not asked": unlike the other §2a items, it was not put to Hein
as a question. The archive skips customer invoices referenced by any `paystack_payment_requests`
row of the same company, and reports how many it skipped. Requests are never archived or deleted.

## Fix

- New `core/archiveCustomerInvoiceScope.selectArchivableCustomerInvoices(companyId, cutoff)`
  returns `{ ids, skipped }`. That is one select: paid or cancelled, before the cutoff, plus an
  `EXISTS` on the company's Paystack requests.
- `executeArchive` step 4 calls it once. The copy into `archive_customer_invoices` and the step-6
  delete both use `company_id = X AND id = ANY(ids)`, so an invoice is copied only if it is also
  deleted. `ArchiveResult.invoicesSkipped` is new, and it is also in the audit metadata and the
  completion log. It is a plain read with no `FOR UPDATE`: locking invoices at step 4 would take
  them before the bank lines that step 6 deletes first (canonical lock order).
- `previewArchive` uses the same function: `customerInvoices` counts only the ids, and
  `customerInvoicesSkipped` is new (it is not part of `totalRecords`). `validateArchive` reads the
  preview, so it follows.
- **UI change:** `ArchiveWizardSection` adds one muted line under the preview when
  `customerInvoicesSkipped > 0`. It needs browser proof.

## Tests

- `tests/integration/r186-archive-skips-paystack-invoices.int.test.ts` (3 cases), with three
  companies.
  - A has one referenced invoice and one free invoice. The preview shows 1 archivable and 1 skipped.
    The run archives the free invoice and skips the referenced one with `invoicesSkipped=1`. There is
    no 23514. The referenced invoice stays live and is not in the archive, its request is unchanged,
    the run is `completed`, and B's invoice is untouched.
  - B has its own referenced invoice, plus a request that references C's invoice.
  - C's only invoice is referenced only by B's request. C's preview shows 0 skipped. C's run still
    fails whole on 23514, and nothing moves.
- `tests/unit/components/archiveWizardSkippedInvoices.test.tsx` (2 cases): the line appears with
  the count, and is absent at 0.

| Evidence | Result |
|---|---|
| `red.int.log` (HEAD 1910c157b) | 2 failed / 1 passed (3). Preview expected 1, got 2. Run threw 23514 |
| `red.component.log` | 1 failed / 1 passed (2). The line was not rendered |
| `green.int.log` | 3/3 |
| `mutations.log` | 12 mutants: 10 killed, 2 equivalent (M9, M10). Baselines before and after green |
| `regression.int.log` | k071 + r101 + r186: 7/7 |
| `regression.unit.log` | archiveExecutionSavepoint, dataArchivingExecuteDisabled, automation-groups, savepointRollbackPoison, bankFeedStateReaderCensus: 77/77. Components (r186 + d2CensusG5b): 29/29 |

## Review round 1 (two blind reviewers on 02e4e1224, both FIX)

1. **[H] Unlocked selection, id-only delete.** An invoice reopened between the selection and the
   delete (for example an allocation unwind sets it back to `approved`) was still deleted.
   `moveCustomerInvoicesToArchive` now does both in one statement:
   `WITH moved AS (DELETE ... RETURNING *) INSERT INTO archive_customer_invoices ... SELECT FROM moved`.
   It re-applies company, `invoice_date < cutoff` and `status IN ('paid','cancelled')` on top of
   the id set. It throws `ArchiveSetChangedError` (`ARCHIVE_SET_CHANGED`), and the run rolls back
   whole, in two cases: it deleted fewer rows than it selected, or it archived fewer than it deleted
   (an id already in the archive; `ON CONFLICT DO NOTHING` used to lose such a row silently). The
   selection is still a plain read at step 4. The move runs at step 6's invoice slot, so the lock
   order is unchanged.
   Test `r186-archive-move-race.int.test.ts` covers two windows. A sql wrapper fires a hook after the
   selecting SELECT, and another connection reopens the invoice in one window and re-dates it in the
   other. A third case puts an id that is already in the archive. In each, the hook fired (where
   used), the run failed with `ARCHIVE_SET_CHANGED`, the invoice is live, and nothing new was
   archived.
2. **[M] Closure of a skipped invoice: option (b), the orchestrator's choice.**
   - **Census, sent 2026-10-03.**
     - Probe: a real Paystack settlement through the R-181 helpers, a cancelled unreferenced
       invoice beside it, cutoff 2999-01-01. The run fails whole on
       `23503 customer_payments_gl_journal_entry_id_fkey`. `executeArchive` never archives
       `customer_payments` but deletes their posted journals by date. So any receipt journal before
       the cutoff fails the run, Paystack or not (R-053 class).
     - Closure of a skipped invoice:
       - its own journal: `customer_invoices.gl_journal_entry_id`, no FK, checked with `\d` on the
         fixture;
       - that journal's reversal chain: `reversal_of_id`, NO ACTION;
       - its allocations (NO ACTION) and its receipts (never archived);
       - the receipts' journals (FK, NO ACTION);
       - the gateway fee journal, tied only by `reference`;
       - reconciled bank lines matched to receipt journal lines (`matched_journal_line_id`).
   - **The fix.** `countSkippedInvoiceJournalsInWindow` counts how many journals the run would move
     (posted, before the cutoff, this company) belong to a skipped invoice. That means the
     invoice's own journal plus its reversal chain, walked through `reversal_of_id` in both
     directions inside the company. It is a recursive CTE; `UNION` ends a forged cycle.
     - If the count is not 0, `executeArchive` throws `ArchiveSkippedInvoiceJournalError`
       (`ARCHIVE_SKIPPED_INVOICE_JOURNAL`) at step 4, before anything is deleted, and the run rolls
       back whole.
     - `validateArchive` reports the same count as an error, so the page's Validate predicts the
       refusal. The preview's counts do not change: a refusal is a reason the run won't happen,
       not a number of records.
   - **Receipt, fee and bank closure: recorded, not kept out (R-053 class, fails closed).** A
     receipt journal before the cutoff fails the run on 23503 before the fee journal or bank line
     can matter. A fee journal always comes with a receipt journal.
   - **Pins.**
     - `r186-archive-skipped-closure.int.test.ts` (6 cases). Refused shapes: the realistic cancel
       (the invoice's journal 'reversed', its reversal posted in the window); the journal it
       reverses in the window; its own journal in the window; the same with Stitch. Each asserts
       the code, that nothing moved (journals, invoices, archive) and that validation reports it.
       It completes when no chain journal is one the run moves, and the free invoice's own journal
       moves with it. It does not reach into another company's journals.
     - `r186-archive-paystack-settled.int.test.ts` (2 cases, the realistic Paystack shape through
       the real webhook). With no invoice journal (as the R-181 helper books it): 23503
       `customer_payments_gl_journal_entry_id_fkey`, pre-existing. With the invoice posted to the
       GL: the new refusal, before any delete. Nothing moves in either.
   - **Route.** Neither `ARCHIVE_SKIPPED_INVOICE_JOURNAL` nor `ARCHIVE_SET_CHANGED` can reach a
     response today: `POST /api/accounting/data-archiving` returns 403 before it calls
     `executeArchive` (`tests/unit/api/dataArchivingExecuteDisabled.test.ts`, green in
     `regression.r3.unit.log`). `withErrorHandler` would answer an unmapped error with a 500, so
     whoever re-enables archiving must map both codes to 409. I did not add that mapping to a
     route that never calls the service; it is noted in `core/.claude.md`.
3. **[M] Stitch.** `stitch_payment_requests` has the same shape (`ON DELETE SET NULL` plus
   `stitch_pr_invoice_has_invoice`), so the skip now covers it too (an `OR EXISTS` scoped to the
   same company), with its own cases.
4. **[M] Recorded:** see the next section.
5. **[L] Attribution.** The goal file marks R-186 "default, not asked", so it was not Hein's
   decision. The scope module header, the test header and `core/.claude.md` now say so.
6. **[L] RLS.** The preview and the main run case run as `app_user`, with `request.jwt.claims` and
   `app.current_company_id` set. So do the cross-tenant cases.
   - The policy on `paystack_payment_requests` and `stitch_payment_requests` is the same as the one
     on `customer_invoices`, `archive_customer_invoices` and `archive_runs`: `tenant_isolation` TO
     app_user, `company_id IN (SELECT company_id FROM company_users WHERE user_id = auth.uid())`.
   - It admits every company the user belongs to, not only the active one. The test user belongs to
     all four companies, so B's request is visible while C's archive runs. It is the `company_id`
     predicate, not RLS, that stops that request shielding C's invoice. Mutants N2/N4 (selection)
     and N5/N7 (count) prove this.
7. **[L] Preview.** `countArchivableCustomerInvoices` counts with `COUNT(*) FILTER` in SQL. The id
   list is loaded for execution only.
8. **[L] Evidence on a committed sha.** `green.r2.int.log`, `mutations.r2.log`,
   `regression.r2.*.log` were recorded at `90c05b908` with a clean tree, as their first lines show.
   The round-0 logs (`red.int.log`, `green.int.log`, `mutations.log`, `regression.*.log`) were
   recorded on 1910c157b plus an uncommitted tree, and are kept as history.
9. **[L] UI.** The line now says "a Paystack or Stitch payment request", because the count
   includes Stitch. The component test asserts the new copy and failed on the old one
   (`red.r2.component.log`).

| Round-1 evidence | Result |
|---|---|
| `red.r2.int.log`: round-0 code at 02e4e1224, round-1 tests | 5 failed / 2 passed (7). Preview 2 vs 1. Run threw 23514 on `stitch_pr_invoice_has_invoice`. All three move cases completed instead of refusing |
| `green.r2.int.log` (90c05b908) | 7/7 |
| `mutations.r2.log` (90c05b908) | 20 mutants: 18 killed, 2 equivalent (N12, N16). Baselines before and after green, tree clean |
| `regression.r2.int.log` | k071 + r101 + both r186 files: 11/11 |
| `regression.r2.unit.log` | 5 unit files 77/77. Components 29/29 |
| `red.r3.int.log`: code at 15a59be48, item-2 tests | 4 failed / 3 passed (7). Two shapes completed and half-archived. The other two (backward chain; Paystack with invoice journal) hit a pre-existing 23503 instead of the refusal |
| `green.r3.int.log` (5864081d2) | four r186 files: 15/15 |
| `mutations.r3.log` (5864081d2) | 14 mutants: 12 killed, 2 argued (C10, C11: widening the seed only refuses more). Baselines before and after green, tree clean |
| `regression.r3.int.log` | k071 + r101 + r181-settlement-amount + four r186 files: 38/38 |
| `regression.r3.unit.log` | 5 unit files 77/77. Components 29/29 |

The Stitch case of the closure suite was added after `red.r3.int.log`. Mutant C8 shows it is needed.

## Recorded, not changed

- **Journals of LIVE invoices (pre-existing, outside R-186; registered as R-191).** Steps 1, 2 and 6 move every
  posted pre-cutoff journal by date, including the journal of an invoice the run never selects
  (approved, sent, partly paid). That invoice stays live and points at the archive. The refusal
  covers only skipped invoices, per option (b). Mutants C10 and C11 widen it to every referenced
  invoice and survive; a test that killed them would have to assert this half-archive as correct.
- **Cross-tenant reference.** `customer_invoice_id` is a single-column FK with no trigger, so a
  request can name another company's invoice. That request does not shield the invoice. The
  reference still fails the run on 23514, for Paystack and for Stitch (pinned under app_user).
- **Other NO ACTION FKs into `customer_invoices` still fail the run whole (R-053 class, fails
  closed).** Verified on the fixture, which runs the same schema as this branch (no migration
  here): `credit_notes.customer_invoice_id`, `customer_payment_allocations.invoice_id`,
  `customer_quotes.converted_invoice_id`, `customer_sales_orders.invoice_id`,
  `customer_write_offs.invoice_id`, `delivery_notes.invoice_id`. A selected invoice with any of
  them raises 23503, and the whole run rolls back. So the preview can show N archivable invoices
  for a run that will still fail on these. It does not predict R-053.
- **CASCADE loss (pre-existing).** Deleting an archived invoice also deletes its
  `customer_invoice_items`, `customer_invoice_views`, `customer_invoice_disputes` and
  `dunning_sends`, which are ON DELETE CASCADE. No archive table keeps them.
- **No run-history column.** `archive_runs` has no skipped column, so the run history shows nothing.
  The count is in the result, the audit metadata and the log. Persisting it needs a migration.
- **Archiving is switched off.** `POST /api/accounting/data-archiving` returns 403 (2026-09-24), so
  `executeArchive` has no live caller. R-053 still makes any paid invoice with an allocation fail
  the run on 23503; the k071 pin still holds.
- **Race.** A request created for a selected invoice between step 4 and step 6 makes the move fail
  on 23514, and the run rolls back whole.
