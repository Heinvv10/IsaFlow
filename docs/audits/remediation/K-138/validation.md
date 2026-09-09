# K-138 — supplier sub-resources accept an unchecked supplier id

**Claim.** "Three routes take the supplier id from the body without a company check, leaking a
foreign supplier name through a later join."

**Disposition: confirmed** for the missing check on all three routes; the *leak* half of the claim
is corrected below.

**The three routes** (all `origin/master`):
1. `pages/api/accounting/supplier-returns.ts:52,72` — `supplierId` → `credit_notes.supplier_id`.
2. `pages/api/accounting/purchase-orders.ts:43` — `body.supplierId` → `purchase_orders.supplier_id`
   (`validatePurchaseOrder` checks non-empty only, procurementService.ts:71).
3. `pages/api/accounting/credit-notes.ts:46,64` — `supplierId` → `createCreditNote`.

**Corrected impact.** The FK to `suppliers(id)` is not a tenant check: PostgreSQL referential
integrity is not subject to RLS. Proven directly against the fixture schema as `app_user` under the
`tenant_isolation` policy — the insert of another company's supplier id succeeded, and the
supplier-returns list query then rendered `supplier_name = Unknown`, because FORCE row security on
`suppliers` hides the row. So for a single-company user there is **no name leak**; there is a
cross-tenant dangling reference no AP report can resolve. The name DOES leak for a user who belongs
to both companies, because the read policy is `company_id IN (SELECT auth.user_companies())` — every
company the user is a member of, not the active one. Re-ran with the user added to company B and the
list rendered `FOREIGN SUP`.

**RED.** `tests/integration/k138-supplier-subresource-ownership.int.test.ts` — 3 failed of 3, one per
route. Log: `red.log`. Note the credit-notes case answered ≥400 *and still wrote the row* — the
partial-write shape, worth flagging separately.

**Proposed minimal fix.** One company-scoped existence check per route before the write:
`SELECT 1 FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId} AND
deleted_at IS NULL` → `apiResponse.badRequest('Supplier not found for this company')`. Better, put it
in one helper (`assertSupplierInCompany`) used by all three, since the same body-id shape recurs.

**Historical-data impact.** Rows may exist. Read-only census, per table:
`SELECT cn.id, cn.company_id, s.company_id AS supplier_company FROM credit_notes cn
 JOIN suppliers s ON s.id = cn.supplier_id WHERE s.company_id <> cn.company_id;`
and the same shape for `purchase_orders`. Run as a superuser (RLS would hide exactly the rows being
looked for). Any hit is a mis-attributed debit note or PO and needs a decision, not an automatic
rewrite.

**Risks.** None to the happy path; the check adds one indexed lookup per write.
