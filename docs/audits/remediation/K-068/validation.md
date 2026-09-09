# K-068 — Supplier statement endpoint casts a UUID with Number()

**Claim.** `Number(supplier_id)` yields NaN against a UUID column, so the
endpoint 500s for every caller.

**Corrected trigger.** The claim was accurate at the audited SHA. `git show
5661d6f0:pages/api/accounting/supplier-statement-detail.ts` line 44 reads
`WHERE id = ${Number(supplier_id)} AND company_id = ${companyId}`, and the same
cast appears on the invoices, payments and returns queries below it. `suppliers.id`
is `uuid`, so the parameter raises 22P02 and the route answers 500.

**Disposition: ALREADY-FIXED-VERIFIED.**

**Evidence.** Commit `798082d8` "fix(ap): load supplier statements using UUID
identifiers" replaced every cast with the raw value and added an
`isUuidParam(supplier_id)` guard that answers 400 before any query
(`git show origin/master:pages/api/accounting/supplier-statement-detail.ts`,
lines 39-49). Two current tests, both executed:

- `tests/unit/services/ap/supplierStatementDetailApi.test.ts` — **8 passed**.
  It drives the handler and asserts a 400 with no query for `undefined`, `'123'`,
  `'invalid'` and an array, and a 200 carrying the UUID and the company id into
  every `sql` call.
- `tests/integration/k068-supplier-statement-uuid-cast.int.test.ts` (added here)
  — **2 passed** against real PostgreSQL. It proves the pre-fix shape still
  raises 22P02 on the live schema and the current shape loads the supplier, so
  the defect was real and is gone rather than merely untested.

**Reachability.** `GET /api/accounting/supplier-statement-detail`, reached from
`pages/accounting/supplier-statements/[supplierId].tsx`.

**Proposed fix.** None — landed. Keep both tests as the regression pin.

**Historical-data impact.** None. The defect was a read path that failed; it
wrote nothing. Statements were unavailable while it stood, no rows were
corrupted.

**Risks.** None outstanding.
