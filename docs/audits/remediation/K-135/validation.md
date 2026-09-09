# K-135 — createSupplierInvoice does not verify supplier ownership

**Claim.** The supplier id from the body is inserted with no company check.

**Corrected trigger.** `createSupplierInvoice`
(`supplierInvoiceService.ts:66-180`) takes `input.supplierId` and inserts it verbatim
(lines 123-141). The only statement naming both the supplier and the company is the
duplicate-fingerprint lookup at line 113,
`SELECT vat_number FROM suppliers WHERE id = … AND company_id = …`, whose result is
read as `supplierVatRow?.vat_number ?? null` — zero rows is a normal outcome, not a
refusal. `supplier_invoices_supplier_id_fkey` references `suppliers(id)` with no company
predicate, so the row is accepted.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ap/supplierInvoiceService.ts:110-145`.
- Schema: `supplier_invoices_supplier_id_fkey FOREIGN KEY (supplier_id) REFERENCES
  suppliers(id)` — no company column in the constraint.
- Executed RED test, 1 of 1 failing: a bill for company A naming company B's supplier is
  created and returned.

**Consequences.** The bill is a payable of A pointing at B's supplier row. Every AP read
joins `suppliers` on `company_id`, so it is invisible in A's supplier ledger and its
supplier name comes back empty; B can no longer delete that supplier; and
`pages/api/accounting/netcash/submit.ts` joins `suppliers s ON sp.supplier_id = s.id`
with NO company predicate of its own, so B's bank account number can be carried into
A's payment file. It is a cross-tenant write, which is the class this repo treats as
non-negotiable.

**Reachability.** `POST /api/accounting/supplier-invoices` with an attacker-chosen
`supplierId`, and the MCP `create_supplier_invoice` tool on the same service. Supplier
ids are UUIDs, so the caller needs one — a former employee, a bureau operator with two
tenants, or a leaked id.

**RED test.** `tests/integration/k135-create-supplier-invoice-foreign-supplier.int.test.ts`
(1 test, 1 failed) — output in `red.log`.

**Proposed minimal fix.** Promote the existing lookup at line 113 to the guard it should
already be: select `id, vat_number`, and `if (!supplierVatRow) throw new Error('Supplier
not found')` before computing the fingerprint. One line added, no new query. The AP
module already has this shape in `createSupplierPayment`.

**Historical-data impact.** Read-only impact query (NOT run — production out of scope):

```sql
SELECT si.company_id, s.company_id AS supplier_company, COUNT(*)
FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
WHERE s.company_id <> si.company_id
GROUP BY 1, 2;
```

Any hit is a cross-tenant document that needs re-pointing or cancelling, and its GL
journal reviewed.

**Risks.** None. The refusal is on a path that should never have succeeded. Check the
same guard on `purchaseOrderId`, `grnId`, `projectId` and `costCenterId`, which are
inserted from the body under the same absence of a check — worth its own id.
