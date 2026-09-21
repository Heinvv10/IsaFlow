# K-045 — documents cannot be attached to real supplier invoices

**Claim.** `verifyEntityOwnership` unions the Sage staging table but not `supplier_invoices`,
so every upload against a live bill is refused.

**Corrected trigger.** `src/modules/accounting/services/core/documentStorageService.ts:84-91`
unions `sage_supplier_invoices`, `customer_invoices`, `supplier_payments`,
`customer_payments`, `credit_notes`. `supplier_invoices` — the live AP bill table — is absent,
while `supplier_invoice` is a member of `VALID_ENTITY_TYPES` (:20). The refusal is wider than
"upload": the same predicate fences the READ path
(`documentQueryService.ts:53`, which returns `entity_not_found`), so an existing bill shows no
documents either. `autoLinkSupplierInvoice` (:158) reads `sage_supplier_invoices` too, so a
Sage-migrated bill works and a natively captured one does not.

**Disposition: confirmed.**

**Evidence.** Baseline `origin/master` = `0f16391e`; file unchanged since `5661d6f0`.
RED test against the disposable fixture:
`tests/integration/k-045-documents-supplier-invoice-ownership.int.test.ts` — 2 tests,
2 failed. With a real `supplier_invoices` row for the company, `verifyEntityOwnership`
returned `false` while the customer-invoice control on the same call returned `true`, and
`listEntityDocuments(company, 'supplier_invoice', bill, 20, 0)` returned
`{ ok: false, reason: 'entity_not_found' }`. Log: `docs/audits/remediation/K-045/red.log`.

**Reachability.** `pages/api/accounting/documents.ts:118` refuses the upload and `:179` the
per-document read; `documentQueryService.listEntityDocuments` refuses the listing. Both are
live routes behind `withAuth`.

**Proposed minimal fix.** Add one branch to the UNION at
`documentStorageService.ts:85-90`: `UNION ALL SELECT 1 FROM supplier_invoices WHERE id =
${entityId}::uuid AND company_id = ${companyId}`. Keep the `sage_supplier_invoices` branch —
migrated bills still live there. Consider the same audit for `autoLinkSupplierInvoice`, which
silently returns when the id is not a Sage row, but that is a separate, non-blocking gap.

**Historical impact.** No wrong rows. The loss is documents that were never attached: proof of
payment and supplier bills that users tried to upload and could not. Any
`procurement_documents` row with `entity_type = 'supplier_invoice'` pointing at a
`supplier_invoices` id would predate the ownership check; count them read-only (not run here):
```sql
SELECT count(*) FROM procurement_documents pd
JOIN supplier_invoices si ON si.id = pd.entity_id
WHERE pd.entity_type = 'supplier_invoice';
```

**Risks.** Low. The added branch is company-scoped exactly like its siblings, so it widens the
allowed set without widening tenant reach. Verify no id can exist in both
`supplier_invoices` and `sage_supplier_invoices` for different companies before shipping.
