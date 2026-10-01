# K-130 — supplier statement counts draft bills as owed

**Claim.** `supplierStatementService.ts:118` includes unapproved documents in the
amount payable.

**Corrected trigger.** The bill query filters `status != 'cancelled'` only. The
in-repo authority on what we owe is `apAgingService.ts` (lines 88 and 152), which
filters `si.status NOT IN ('draft','cancelled')`. So a DRAFT bill — captured,
unapproved, carrying no GL journal — is credited into the statement balance while
aged creditors excludes it. The statement we send a supplier therefore disagrees with
our own creditors report. `pending_approval` is included by BOTH and is not part of
this finding. The service's own header claims unsettled documents are named in
`excluded` rather than silently counted; drafts get neither treatment.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/supplierStatementService.ts`
  lines 116-124 (the filter) against `.../ap/apAgingService.ts:88,152`.
- Executed RED test: statement balance 1650 where aged creditors gives 1250.

**Reachability.** Every caller of `fetchSupplierStatementData` — the supplier statement
page, its PDF and its email.

**RED test.** `tests/integration/k130-k131-supplier-statement.int.test.ts`
(3 tests, 2 failed — one of the two failures is K-131) — output in `red.log`.

**Note on the AR twin.** `ar/statementEmailService.ts:88` carries the identical
`status != 'cancelled'` filter, so the customer statement counts draft invoices as
receivable in exactly the same way. Fix both or neither; a one-sided fix reintroduces
the asymmetry this service was built to avoid.

**Proposed minimal fix.** Change the predicate to
`AND status NOT IN ('cancelled','draft')`, and push each excluded draft onto
`excluded` with a reason (`invoice_not_approved`) and its amount, the way the payment
and credit-note branches already do. Roughly four lines, plus the mirror in the AR
service.

**Historical-data impact.** No stored row is wrong. Statements already sent or printed
overstate the payable by the draft bills open on that date. Read-only impact query
(NOT run — production out of scope):

```sql
SELECT company_id, COUNT(*) AS draft_bills, SUM(total_amount) AS overstated
FROM supplier_invoices WHERE status = 'draft' GROUP BY company_id;
```

**Risks.** A tenant using `draft` as a working status for genuinely-owed bills would
see its statement balance fall. That is the point, and it aligns the statement with the
creditors report they reconcile against.
