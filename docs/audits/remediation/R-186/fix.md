# R-186: the archive skips customer invoices a Paystack or Stitch request references

## Defect

`executeArchive` deleted every paid or cancelled customer invoice dated before the cutoff.
`paystack_payment_requests.customer_invoice_id` is `ON DELETE SET NULL`, and
`paystack_pr_invoice_has_invoice` requires it for purpose `customer_invoice`. So deleting an
invoice such a request references raised 23514, and the whole run rolled back to its savepoint
(`red.int.log`: `executeArchive threw 23514 ... paystack_pr_invoice_has_invoice`).

## Product consequence (for Hein)

Under option (b), a GL-posted paid invoice keeps its `gl_journal_entry_id`. That journal stays
`posted` (a reversal never changes the original's status; `journalEntryListService.ts:14`) and is
dated on the invoice date, so before the cutoff. **So the run refuses whole for ANY company that has
a GL-posted invoice before the cutoff referenced by a Paystack or Stitch request. In practice such a
company cannot archive until R-053 and R-191 are redesigned.** Its receipt journal would fail the
run on 23503 anyway (R-053). The only skipped invoices a completed run leaves behind are ones
cancelled by today's `cancelCustomerInvoice`, which NULLs the link. The preview line says this: it
does not suggest that the other invoices are archived anyway.

## Current design (as of round 2)

**Decision.** This is the goal file's default, not a decision put to Hein
(`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`, §2a item 5 and §4, marked "default,
not asked"). The archive skips the customer invoices a Paystack or Stitch payment request of the
same company references, and reports how many it skipped. Requests are never archived or deleted.
Review round 1 extended it to Stitch (item 3). The orchestrator chose option (b) for the skipped
invoice's journals (item 2).

**Fix.** Everything lives in `core/archiveCustomerInvoiceScope.ts`:
- `selectArchivableCustomerInvoices` → `{ ids, skippedIds }`. One unlocked read at step 4: paid or
  cancelled, before the cutoff, and an `EXISTS` on each request table scoped to the company.
- `countSkippedInvoiceJournalsInWindow(companyId, cutoff, skippedIds)`. Seeded from the selection's
  `skippedIds`, so an invoice changed after the selection cannot escape. It walks each invoice's
  `gl_journal_entry_id` and that journal's `reversal_of_id` chain, both directions, inside the
  company, and counts the journals the run would move (posted, before the cutoff).
  - If the count is not 0, the run throws `ArchiveSkippedInvoiceJournalError`
    (`ARCHIVE_SKIPPED_INVOICE_JOURNAL`) before any delete.
  - `validateArchive` reports the same count, with a message that is true both before a run and as
    a refused run's stored error.
- `moveCustomerInvoicesToArchive` is one statement at step 6:
  `WITH moved AS (DELETE ... RETURNING *) INSERT INTO archive ... SELECT FROM moved`. It re-applies
  company, cutoff and status on top of the ids. It throws `ArchiveSetChangedError`
  (`ARCHIVE_SET_CHANGED`) when it deletes fewer rows than it selected, or archives fewer than it
  deletes.
- **One definition each** (round-2 addendum C): `eligibleInvoice` (company, before the cutoff, paid or
  cancelled) and `gatewayReferenced` (an `EXISTS` on each request table, same company) are nested
  `sql` fragments, spliced into the selection, the preview count and the move.
- `countArchivableCustomerInvoices` drives the preview: `customerInvoices` and
  `customerInvoicesSkipped`, counted in SQL.
- `ArchiveResult.invoicesSkipped` is in the result, the audit metadata and the log.
- The page shows one line under the preview when the skipped count is above 0 (browser proof:
  `browser-proof.md`).

**Tests.**

| File | Covers |
|---|---|
| `r186-archive-skips-paystack-invoices` | Runs as app_user. Paystack and Stitch skips. Preview counts. Cross-tenant requests don't shield (23514) |
| `r186-archive-move-race` | Hook after the selection: an invoice reopened or re-dated, an id already in the archive (`ARCHIVE_SET_CHANGED`), a skipped invoice reopened (still refused) |
| `r186-archive-skipped-closure` | Option (b) on hand-built rows. The `status='reversed'` shapes are LEGACY cancels |
| `r186-archive-current-cancel` | Today's cancel, built by the real `postCustomerInvoiceToGL` and `cancelCustomerInvoice` |
| `r186-archive-paystack-settled` | Settlement through the real Paystack webhook |
| `archiveWizardSkippedInvoices` (component) | The preview line |

## Round 0 (superseded; kept as history)

### Decision (round 0)

Goal file `.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`, §2a item 5 and §4. The
goal file marks this item "default, not asked": unlike the other §2a items, it was not put to Hein
as a question. The archive skips customer invoices referenced by any `paystack_payment_requests`
row of the same company, and reports how many it skipped. Requests are never archived or deleted.

### Fix (round 0)

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

### Tests (round 0)

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
     - `r186-archive-skipped-closure.int.test.ts` (6 cases). Refused shapes: a LEGACY cancel
       (the invoice still points at an original left at status='reversed', its reversal posted in
       the window; today's cancel does not leave this shape, see round 2); the journal it
       reverses in the window; its own journal in the window; the same with Stitch. Each asserts
       the code, that nothing moved (journals, invoices, archive) and that validation reports it.
       It completes when no chain journal is one the run moves, and the free invoice's own journal
       moves with it. It does not reach into another company's journals.
     - `r186-archive-paystack-settled.int.test.ts` (2 cases: a settlement through the real Paystack
       webhook; the invoice row and its optional journal are seeded). With no invoice journal (as the R-181 helper books it): 23503
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

## Review round 2 (general reviewer on bbf439af4: no code defect, FIX on these)

1. **[M] Browser proof.** `browser-proof.md` and `browser-proof-preview.png`. On
   `isaflow-fixture-r186` at `0ef5c9cd3`, the preview answered 200 with `customerInvoices: 1` and
   `customerInvoicesSkipped: 1`, the line rendered, and there were no console errors.
2. **[L] Current cancel shape.** `cancelCustomerInvoice` keeps the original journal `posted` and
   stamps `reversed_at`, posts the reversal with `reversal_of_id` on the same date, and NULLs
   `gl_journal_entry_id`. `r186-archive-current-cancel.int.test.ts` builds that shape with the real
   `postCustomerInvoiceToGL` and `cancelCustomerInvoice`, asserts the shape, and then runs the
   archive.
   - The run completes: `invoicesSkipped 1`, `invoicesArchived 1`, `entriesArchived 2`. Both
     journals move, and the live cancelled invoice points at nothing, so nothing dangles.
   - So for a cancelled invoice, the refusal bites only on LEGACY rows: an invoice still pointing
     at a `status='reversed'` original. Those cases in the closure suite are now labelled legacy,
     and the round-1 "realistic" wording above is corrected.
   - It passed on the round-1 code as well. It pins behaviour; it is not a red-first fix.
3. **[L]** The "Current design" section above replaces the round-0 Decision, Fix and Tests, which
   are kept, headed as superseded.
4. **[L] Non-atomic selection and count.** The journal count is now seeded from the ids the
   selection skipped, not from its own read of the request predicate.
   - Red: `red.r4.int.log` on bbf439af4. A skipped invoice reopened to `approved` after the
     selection escaped the refusal, and its in-window journal was archived.
   - Validation uses the same selection, so it loads the eligible ids; the preview still only
     counts.
   - Still not atomic, and recorded: a journal posted or reversed between the count (step 4) and
     the GL deletes (step 6) is not re-checked.
5. **[L] Message wording.** `skippedInvoiceJournalMessage` now reads "... are dated before the
   cutoff. An archive with this cutoff is refused; choose an earlier cutoff." That is true from
   Validate and as `archive_runs.error_message`.

| Round-2 evidence | Result |
|---|---|
| `red.r4.int.log` (bbf439af4, new race case) | 1 failed / 3 passed (4): the run completed and archived the reopened invoice's journal |
| `green.r4.int.log` (0ef5c9cd3) | five r186 files: 17/17 |
| `mutations.r4.log` (0ef5c9cd3) | 18 mutants over the selection, the seed, the chain, the count, the refusal and validation: 18 killed. Baselines before and after green, tree clean |
| `regression.r4.int.log` | k071 + r101 + r181-settlement-amount + five r186 files: 40/40. `d8-r2-chain-head-cancel-void` refuses any DB but isaflow_dev, so it cannot run on the fixture; the cancel service is unchanged here |
| `regression.r4.unit.log` | 5 unit files 77/77. Components 29/29 |

## Review round 2 addendum (adversarial reviewer, no HIGH)

- **A. [M, pre-existing] registered as R-192.** Steps 1, 2, 3 and 5 copy rows (`ON CONFLICT DO
  NOTHING`), and step 6 deletes them by predicate in a separate statement, each statement on its own
  READ COMMITTED snapshot. A supplier invoice, bank line or journal that changes in between is lost
  or left as a stale copy. The fix is the same `DELETE ... RETURNING` into `INSERT`, with count
  checks per table, in the archive redesign. Not fixed here. R-192 was checked free on every ref and
  worktree first; r187 already holds R-193.
- **B. [L]** The legacy relabel and the current cancel shape were done in round 2 item 2. The
  product consequence is now stated above, in `core/.claude.md` and in the register. The preview
  line now reads: "N paid or cancelled customer invoice(s) before the cutoff cannot be archived: a
  Paystack or Stitch payment request refers to them. If any of them has a journal before the
  cutoff, the whole archive is refused; Validate reports it." `red.r5.component.log` shows the
  test failing on the old copy. Browser proof was re-run: `browser-proof.md`.
- **C. [L]** `eligibleInvoice` and `gatewayReferenced` are each defined once, and the selection, the
  preview count and the move splice them in. The refusal seed has used the selection's
  `skippedIds` since round 2, so it has no copy of its own. That is why C10 and C11 (which mutated
  the seed's status and cutoff) no longer exist: there is nothing left for them to mutate.
  - The move-race test's `sql` mock now returns the real lazy query for every call except the
    selection, so the nested fragments still splice.
  - Mutants on the single definitions are in `mutations.r5.log`.

## Recorded, not changed

- **Copy-then-delete on the other tables (pre-existing; registered as R-192).** See the round-2 addendum.
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
