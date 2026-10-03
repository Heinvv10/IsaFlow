# R-186: the archive skips customer invoices a Paystack or Stitch request references

## Defect

`executeArchive` deleted every paid or cancelled customer invoice dated before the cutoff.
`paystack_payment_requests.customer_invoice_id` is `ON DELETE SET NULL`, and
`paystack_pr_invoice_has_invoice` requires it for purpose `customer_invoice`. So deleting an
invoice such a request references raised 23514, and the whole run rolled back to its savepoint
(`red.int.log`: `executeArchive threw 23514 ... paystack_pr_invoice_has_invoice`).

## Product consequence (for Hein)

Under option (b), a GL-posted invoice keeps its `gl_journal_entry_id` until it is cancelled. That
journal stays `posted` (a reversal never changes the original's status; `journalEntryListService.ts:14`)
and is dated on the invoice date (`r186-archive-current-cancel` asserts this for
`postCustomerInvoiceToGL`), so it falls before the cutoff. **So any company with a PAID, GL-posted
invoice before the cutoff that a Paystack or Stitch request references cannot archive at all: the
whole run is refused. In practice such a company cannot archive past that date until R-053 and
R-191 are redesigned.**

What a run does with a skipped (request-referenced) invoice, checked against the code and pinned by
the tests named:

| Skipped invoice | Run outcome | Pinned by |
|---|---|---|
| Paid, GL-posted (link set, journal posted before the cutoff) | Refused whole: `ARCHIVE_SKIPPED_INVOICE_JOURNAL` | `r186-archive-paystack-settled` case 2, `r186-archive-skipped-closure` "own journal" and Stitch cases |
| Paid through a real receipt, with or without its own journal | Fails whole anyway: the receipt journal raises 23503 `customer_payments_gl_journal_entry_id_fkey` (R-053 class). Case 2 refuses first, because the refusal runs at step 4 | `r186-archive-paystack-settled` case 1 |
| Cancelled by today's `cancelCustomerInvoice` (link NULLed; original and reversal both posted) | Completes: invoice skipped, both journals archived, nothing left pointing at the archive | `r186-archive-current-cancel` |
| LEGACY cancel: the link still points at a `status='reversed'` original, or into a chain with a posted journal before the cutoff | Refused whole | `r186-archive-skipped-closure` forward and backward cases |
| LEGACY cancel whose chain has no posted journal before the cutoff | Completes | `r186-archive-skipped-closure` "completes" case |
| Paid with no journal and no receipt (for example set paid by hand or by an import) | Completes, invoice skipped | `r186-archive-skips-paystack-invoices` |

So a completed run leaves skipped invoices behind only when none of them has a journal before the
cutoff. In practice those are invoices cancelled today, and paid invoices that were never posted
and have no receipt. The preview line says that skipped invoices cannot be archived and that any
journal of theirs refuses the whole archive. It does not suggest that the rest goes ahead.

## Current design (as of the PR #632 review)

**Decision.** This is the goal file's default, not a decision put to Hein
(`.claude/handoffs/2026-10-03-r183-r187-pool-budget-goal.md`, §2a item 5 and §4, marked "default,
not asked"). The archive skips the customer invoices a Paystack or Stitch payment request of the
same company references, and reports how many it skipped. Requests are never archived or deleted.
Review round 1 extended it to Stitch (item 3). The orchestrator chose option (b) for the skipped
invoice's journals (item 2).

**Fix.** Everything lives in `core/archiveCustomerInvoiceScope.ts`:
- `selectArchivableCustomerInvoices` → `{ ids, skippedIds }`. One unlocked read at step 0, before
  anything is copied: paid or cancelled, before the cutoff, and an `EXISTS` on each request table
  scoped to the company.
- `countSkippedInvoiceJournalsInWindow(companyId, cutoff, skippedIds)`. Seeded from the selection's
  `skippedIds`, so an invoice changed after the selection cannot escape. It walks each invoice's
  `gl_journal_entry_id` and that journal's `reversal_of_id` chain, both directions, inside the
  company, and counts the journals the run would move (`movedJournal`).
  - If the count is not 0, the run throws `ArchiveSkippedInvoiceJournalError`
    (`ARCHIVE_SKIPPED_INVOICE_JOURNAL`) at step 0, before any copy or delete.
  - `validateArchive` reports the same count, with a message that is true both before a run and as
    a refused run's stored error.
- A second kept-journal count runs just before the GL deletes, with the skipped invoices held `FOR
  SHARE` (`lockSkippedInvoices`, bounded). The lock protects the INVOICE ROW only, so the link
  cannot change until the run ends. Any journal of the chain is still deleted without a copy if it
  is posted, or re-dated into the window, after the second count; that includes the invoice's own
  linked journal (R-192 class). A chain journal posted between step 1 and the second count IS
  caught: the second count sees it and the run refuses.
- `moveCustomerInvoicesToArchive` is one statement at step 6:
  `WITH moved AS (DELETE ... RETURNING *) INSERT INTO archive ... SELECT FROM moved`. On top of the
  ids it re-applies `eligibleInvoice` and `NOT gatewayReferenced`. It throws `ArchiveSetChangedError`
  (`ARCHIVE_SET_CHANGED`) in two cases, each with its own message: it deleted fewer rows than it
  selected (reopened, re-dated, or a request opened on it since), or it archived fewer than it
  deleted ("N invoice id(s) already in the archive").
- **One definition each** (round-2 addendum C): `eligibleInvoice` (company, before the cutoff, paid or
  cancelled) and `gatewayReferenced` (an `EXISTS` on each request table, same company) are nested
  `sql` fragments, spliced into the selection, the preview count and the move. `movedJournal`
  (company, posted, before the cutoff, over `je`) is the one definition of "the run moves this
  journal", spliced into steps 1, 2 and 6 and the refusal count (round 3).
- `countArchivableCustomerInvoices` drives the preview: `customerInvoices` and
  `customerInvoicesSkipped`, counted in SQL.
- `ArchiveResult.invoicesSkipped` is in the result, the audit metadata and the log.
- The page shows one line under the preview when the skipped count is above 0 (browser proof:
  `browser-proof.md`).

**Tests.**

| File | Covers |
|---|---|
| `r186-archive-skips-paystack-invoices` | Runs as app_user. Paystack and Stitch skips. Preview counts. Audit metadata `invoicesSkipped`. Cross-tenant requests don't shield (23514) |
| `r186-archive-move-race` | Hook after the selection: an invoice reopened, re-dated, or a request opened on it (`ARCHIVE_SET_CHANGED`); an id already in the archive (its own message); a skipped invoice reopened (still refused); a refused run issues no archive INSERT or DELETE |
| `r186-archive-skipped-closure` | Option (b) on hand-built rows; a refused run is recorded as `failed` with its reason. The `status='reversed'` shapes are LEGACY cancels |
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
     route that never calls the service; it is noted in `core/.claude.md`. The lock wait's
     `ROW_LOCK_TIMEOUT` (`RowLockTimeoutError`, PR review) is different: it is a held row, not a
     refusal. It must answer 503 + Retry-After, as the other D8 routes do, through
     `respondIfLockTimeout` (`@/lib/apiDocumentLock`), never 409 or 500. `withErrorHandler`
     already does that for any `*_LOCK_TIMEOUT` (`respondToUnhandledError` calls
     `respondIfLockTimeout`).
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

| Addendum evidence | Result |
|---|---|
| `red.r5.component.log` (ac625482a component, new test) | 1 failed / 1 passed (2): the old copy did not mention the refusal |
| `mutations.r5.log` (b34ba09c2; E10 re-run at df8d76509) | 12 mutants on `eligibleInvoice`, `gatewayReferenced`, the move, the preview count and the line: 12 killed. E10 (the preview count ignoring eligibility) first SURVIVED; company E was added to the preview case (an approved invoice, one paid after the cutoff, an approved referenced one), and it is now RED |
| `green.r5.int.log` (df8d76509) | five r186 files: 17/17 |
| `regression.r5.int.log` | k071 + r101 + r181-settlement-amount + five r186 files: 40/40 |
| `regression.r5.unit.log` | 5 unit files 77/77. Components 29/29 |
| `browser-proof.md` (df8d76509) | Preview 200, 1 archivable and 1 skipped, the new line rendered, no console errors |

## Review round 3 (LOWs only: adversarial SHIP, general FIX)

1. The move now also re-applies `NOT gatewayReferenced`, so a request opened on a selected invoice
   after the selection gives `ARCHIVE_SET_CHANGED`, not a raw 23514 (race case; red: 23514). The
   three doc claims (fix.md, `core/.claude.md`, the scope module) now match the code.
2. The preview line reads "... If one of them is still linked to a journal before the cutoff, the
   whole archive is refused; Validate checks this." It no longer claims that every journal refuses:
   today's cancels and legacy chains outside the window complete. The browser proof was
   re-captured.
3. The completed run's `audit_log.changes.metadata.invoicesSkipped` is asserted (`'2'`, stored as a
   string).
4. A refused run, committed the way withAuth commits a handled failure, leaves `archive_runs` at
   `status='failed'` with the reason in `error_message`.
5. The selection and the refusal are now step 0, before step 1. They only read, so the lock order
   is unchanged. A refused run copies nothing: a test records every statement the run issues and
   asserts that no `INSERT INTO archive_*` or `DELETE` precedes the refusal (red: 3 copies).
6. `movedJournal` is the one fragment for "the run moves this journal" (steps 1, 2, 6 and the
   refusal count).
7. "N invoice id(s) already in the archive" is its own message (red: the generic one).
8. The R-186 register census (3) covers Stitch.
9. The CASCADE loss is registered as R-194 (checked free on every ref and worktree).

10. **Final LOW (adversarial reconfirm at e24c3644c).** Moving the refusal to step 0 widened the
    window before the step-6 journal deletes. The kept-journal count now runs a second time, right
    after the invoice move and before the `gl_journal_lines` delete, and throws the same refusal;
    the savepoint rolls the copies back. Race case: a hook fires after the step-0 count and links
    the skipped invoice to a posted pre-cutoff journal. The run refuses, the journal is still live
    and not archived, and the hook fired. Red: `red.r7.int.log`, where the run completed and
    archived the journal. Mutants (`mutations.r7.log`, e5a50021f): dropping the second check, or
    the step-0 check, each turns the suite red (2/2). Green 21/21 (`green.r7.int.log`); regression
    integration 44/44, unit 77/77, components 29/29 (`regression.r7.*.log`).

| Round-3 evidence | Result |
|---|---|
| `red.r6.int.log` (c01557f36 code, round-3 tests) | 3 failed / 17 passed (20): raw 23514; three archive copies before the refusal; the generic message |
| `red.r6.component.log` | 1 failed / 1 passed (2): the old copy |
| `mutations.r6.log` (8f9cc4fbe) | 10 mutants (gateway re-check in the move, step 0 order, audit metadata, failure mark, three `movedJournal` predicates, the already-archived message and check, the copy): 10 killed |
| `green.r6.int.log` (8f9cc4fbe) | five r186 files: 20/20 |
| `regression.r6.int.log` | k071 + r101 + r181-settlement-amount + five r186 files: 43/43 |
| `regression.r6.unit.log` | 5 unit files 77/77. Components 29/29 |
| `browser-proof.md` (8f9cc4fbe) | Preview 200, 1 archivable and 1 skipped, the round-3 line rendered, no console errors |

## CI at 59ffae6bf: the REFUSAL_CODES census

`tests/unit/mcp/typedRefusalReachesAgent.test.ts` failed: "ARCHIVE_SET_CHANGED is declared in src/
but missing from REFUSAL_CODES in toolHelpers.ts". `ARCHIVE_SKIPPED_INVOICE_JOURNAL` would have
failed next.
- Both are now listed in `REFUSAL_CODES` (`src/lib/mcp/tools/toolHelpers.ts`), so their messages
  reach an agent instead of the fallback. Both carry fixed text plus counts only: no id, amount or
  table name.
- No MCP tool runs an archive today.
- `toolHelpers.ts` was already 385 lines on origin/master; this adds 2.

**Lesson:** a new class with `readonly code = '...'` under `src/` must be registered in
`REFUSAL_CODES` (or, if it is not a refusal, in `NOT_A_REFUSAL_CODES`) in the same commit. Running
only the item's own tests does not catch it; the full unit suite does.

After the fix, at `136bf9848`: the full unit suite had 1336 files passed and 47 skipped, 18733 tests
passed and 290 skipped (`full-unit.r8.log`). The component suite passed 403/403 files and
3951/3951 tests (`full-components.r8.log`).

## PR #632 review (blind /review APPROVED with 2 MEDIUMs and LOWs, at 1daa3eb88)

1. **[M] The second check was an unlocked read.** A concurrent `UPDATE customer_invoices SET
   gl_journal_entry_id = X` on a skipped invoice could commit after it, and step 6 would then delete
   X (the link has no FK). `lockSkippedInvoices` now takes the skipped rows `FOR SHARE` just before
   the second count and holds them until the run ends.
   - Lock order: invoices before GL. The lock comes after the invoice move and before the GL
     deletes.
   - The wait is bounded like the D8 locks (`withRowLockBudget`, 5 s, then `RowLockTimeoutError`,
     `ROW_LOCK_TIMEOUT`, already in `REFUSAL_CODES`). Before this, the archive bounded none of its
     locks.
   - Race case: a second connection writes the link after the second check. The test watches
     `pg_blocking_pids` and sees the UPDATE wait for the run. The run, which saw no link, completes
     and archives the journal; the UPDATE lands after the commit. Red: `red.r9.int.log`, where the
     UPDATE did not wait.
   - Recorded: once the run has committed, a writer can still link an invoice to an archived
     journal's id, because there is no FK (R-191 class).
2. **[M] Docs overclaimed "cannot escape".** That now holds for LINKS only. Corrected again in the
   follow-up below: the gap is AFTER the second count, not after step 1. `core/.claude.md`, the `archiveExecutionService` comment and this file now
   say exactly that.
3. **[L] R-195 registered:** a payment request in company B naming company C's invoice blocks C's
   whole archive with 23514. The FK is single-column, it needs forged data, and the entry includes a
   census query. R-195 was checked free on every ref and worktree.
4. **[L] The recursive arm's `je.company_id` filter is pinned:** own journal, then a foreign
   journal reversing it, then an in-window journal of ours reversing the foreign one. The chain must
   not be walked through the foreign journal, so the run completes.
5. **[L] Coverage.** The core coverage (every `r186-*` file) is integration-only. Integration tests
   SKIP on GitHub (empty `DATABASE_URL`), so CI's green does not exercise them. They were run
   locally on `isaflow-fixture-r186`: logs `green.r*.int.log` and `regression.r*.int.log`, each
   headed with its sha. Only the component test and the unit suites run on GitHub.
6. No change for the product-decision LOW (documented above) or the `.claude.md` length (predates
   this PR).

| PR-review evidence | Result |
|---|---|
| `red.r9.int.log` (1daa3eb88 code, new tests) | 1 failed / 15 passed (16): the linking UPDATE did not wait. The cross-company-chain pin passes on that code, which already filters (it pins the filter) |
| `mutations.r9.log` (6dd2bd87c) | 3 mutants: `FOR SHARE` dropped, the lock call dropped, the recursive arm's company filter dropped. 3 killed |
| `green.r9.int.log` (6dd2bd87c) | five r186 files: 23/23 |
| `regression.r9.int.log` | k071 + r101 + r181-settlement-amount + five r186 files: 46/46 |
| `full-unit.r9.log` (6dd2bd87c) | 1336 files passed, 47 skipped; 18733 tests passed, 290 skipped |

Not tested: the lock wait running out (another request holding a skipped invoice FOR UPDATE for
over 5 s gives `RowLockTimeoutError`). That path is `withRowLockBudget`'s own, and that function's
own tests cover it.

## PR #632 follow-up review (APPROVED with 4 LOWs, at 3920aa5a6)

1. The re-enable note (here and in `core/.claude.md`) adds that `ROW_LOCK_TIMEOUT` must answer
   503 + Retry-After through `respondIfLockTimeout`, never 409 or 500. `withErrorHandler` already
   does this for any `*_LOCK_TIMEOUT`.
2. Wording: the `FOR SHARE` protects the invoice row only. A chain journal, the linked one
   included, that is posted or re-dated into the window after the second count is deleted without
   a copy (R-192 class). One posted between step 1 and the second count is caught. Fixed in the
   current-design section, `core/.claude.md` and the `executeArchive` comment.
3. Lock-timeout composition pinned: `r186-archive-skipped-closure`, "held FOR UPDATE past the lock
   budget".
   - Another connection holds a skipped invoice `FOR UPDATE` for 9 s. No seam shortens
     `ROW_LOCK_BUDGET_MS` without a production change, so the case outlasts the real 5 s budget.
   - The run throws `ROW_LOCK_TIMEOUT` in under 9 s. Its row is committed as `failed`, with the
     "being changed by another request" message. Nothing moved (savepoint rollback).
   - Mutants (`mutations.r10.log`, 4d4b17881): `onTimeout` returning a plain Error; `isTimeout` never
     matching (raw 55P03); the wait unbounded. All 3 red.
4. `r186-archive-move-race` disarms every hook and resets `keptCounts`, `fired` and `issued` in a
   `beforeEach`, so no case depends on file order.

Evidence at 4d4b17881: `green.r10.int.log` has five r186 files at 24/24, plus the move-race file
run shuffled (seed 186) at 8/8. `regression.r10.int.log`: 47/47.

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
- **CASCADE loss (pre-existing; registered as R-194).** Deleting an archived invoice also deletes its
  `customer_invoice_items`, `customer_invoice_views`, `customer_invoice_disputes` and
  `dunning_sends`, which are ON DELETE CASCADE. No archive table keeps them.
- **No run-history column.** `archive_runs` has no skipped column, so the run history shows nothing.
  The count is in the result, the audit metadata and the log. Persisting it needs a migration.
- **Archiving is switched off.** `POST /api/accounting/data-archiving` returns 403 (2026-09-24), so
  `executeArchive` has no live caller. R-053 still makes any paid invoice with an allocation fail
  the run on 23503; the k071 pin still holds.
- **Race.** A request created for a selected invoice between step 4 and step 6 makes the move fail
  on 23514, and the run rolls back whole.
