# R-186: the archive skips customer invoices a Paystack request references

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

## Recorded, not changed

- **Cross-tenant reference.** `customer_invoice_id` is a single-column FK with no trigger, so a
  request can name another company's invoice. It does not shield that invoice: under app_user RLS
  another company's request is invisible anyway, and reading it would break tenant scoping. Such a
  reference therefore still fails the run on 23514 (pinned by the third case and by mutant M2).
- **Stitch.** `stitch_payment_requests` has the same shape: `customer_invoice_id ON DELETE SET
  NULL` plus `stitch_pr_invoice_has_invoice`. An invoice a Stitch request references therefore still
  fails the archive on 23514. This is outside the decision, which names Paystack only.
- **No run-history column.** `archive_runs` has no skipped column, so the run history shows nothing.
  The count is in the result, the audit metadata and the log. Persisting it needs a migration.
- **Archiving is switched off.** `POST /api/accounting/data-archiving` returns 403 (2026-09-24), so
  `executeArchive` has no live caller. R-053 still makes any paid invoice with an allocation fail
  the run on 23503; the k071 pin still holds.
- **Race.** A Paystack request created for a selected invoice between step 4 and step 6 makes the
  delete fail on 23514, and the run rolls back whole. It fails closed and is never half-archived.
