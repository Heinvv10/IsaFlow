# K-137 — supplier-invoice PUT is a silent 200 no-op

**Claim.** "PUT on a non-draft invoice is a silent 200 no-op. The guarded UPDATE affects no row and
the re-fetch throw returns 400 after the write already committed."

**Corrected trigger.** There is no throw and no 400. `getSupplierInvoiceById` returns the row (or
`null`) rather than raising, so `pages/api/accounting/supplier-invoices-detail.ts:36-48`
(origin/master) runs an UPDATE guarded by `status IN ('draft','pending_approval')`, ignores the row
count, re-reads and answers **200 with the unchanged invoice**. Two cases:
1. an approved / paid bill — the edit is discarded and the screen reports success;
2. an id belonging to another company — 200 with a `null` body instead of 404.

**Disposition: confirmed** (impact re-stated; the audit's mechanism was wrong).

**Evidence.**
- `git show origin/master:pages/api/accounting/supplier-invoices-detail.ts` lines 32-53.
- `git show origin/master:src/modules/accounting/services/ap/supplierInvoiceService.ts` — the
  `getSupplierInvoiceById` body returns `null` on no rows; it never throws for a missing invoice.
- RED: `tests/integration/k137-supplier-invoice-put-silent-noop.int.test.ts` — 2 failed, 1 passed
  (the draft-edit control passes, so the test is not asserting that PUT is broken generally).
  Log: `red.log`.

**Reachability.** `withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`; any user with
write access to the AP screen. The UI's edit form posts whatever id it is holding.

**Proposed minimal fix.** Capture the row count: `const updated = await sql\`… RETURNING id\``.
If empty, re-read the invoice company-scoped — not found → `apiResponse.notFound`; found but not in
an editable status → `apiResponse.badRequest('Only draft or pending-approval invoices can be
edited')`. Keep the 200 path unchanged. ~6 lines in one file.

**Historical-data impact.** No wrong rows are written — the defect is a lost write, so the damage is
edits users believe they made. Not detectable from the database after the fact; there is no audit
row for a no-op UPDATE. Worth a note to support rather than a backfill.

**Risks.** A client that currently PUTs a posted invoice as part of a save-everything flow will
start seeing 400s. That is the point, but check the AP detail page's save button before shipping.
