# R-068 — an AP document could be booked against another company's supplier

**Branch** `fix/audit-r068-supplier-ownership` · from `origin/master` @ `7d708aac1`
**Severity** MEDIUM (cross-tenant write) — not raised to HIGH: the one path that renders
supplier details outside RLS is dormant on production (below) · **Migration** none

## Reproduction (before the fix)

Measured on the disposable fixture (`isaflow_schema_fixture`), driving the real handlers
through `withAuth`, CSRF and write access, with two throwaway companies: company A posts
company B's supplier id.

| Route | Before | Row written under A with B's supplier |
|---|---|---|
| `supplier-invoices` POST | 201 | `supplier_invoices` |
| `purchase-orders` POST | 201 | `purchase_orders` |
| `purchase-orders/[id]` PUT | 200 | `purchase_orders` (re-pointed) |
| `supplier-purchase-orders` POST / PUT | 201 / 200 | `supplier_purchase_orders` |
| `supplier-payments` POST | 201 | `supplier_payments` |
| `batch-payments` POST | 200 | `supplier_payments` (in a batch) |
| `supplier-returns` POST | 200 | `credit_notes` (type supplier) |
| `recurring-transactions-execute` (bill template naming B's supplier) | 200 | `supplier_invoices` |
| `bank-transactions-action` allocate, supplier | 200 | a posted journal + `supplier_payments`; the name fell back to `Supplier #<id>` |
| `supplier-activities` / `supplier-contacts` POST | 200 | the satellite row |
| `supplier-rules` POST / `supplier-rules/[supplierId]` PATCH | 201 / 200 | `supplier_coding_rules` |
| `supplier-expectations` POST recompute | 200 | `supplier_expectations` |
| `bank-transactions-action` save_selection, supplier | 200 | `bank_transactions.suggested_supplier_id` |
| `adjustments` POST, entityType supplier | 200 | `accounting_adjustments` |
| `bank-rules` POST | **500** | none — see S15 |

A recurring bill template whose `supplierId` is not a UUID answered **500**.

## Root cause

Every foreign key to `suppliers` except one references `suppliers(id)` alone, and the RLS
`WITH CHECK` on each table tests only the row's own `company_id`. Nothing in the schema
stops a supplier id from another tenant. `supplierBelongsToCompany` existed, and only the
MCP tools (`writeSupplierInvoices`, `writeBulkInvoices`, `writeContacts`) called it; every
HTTP route took the id from the body and wrote it. `createSupplierInvoice`'s one supplier
read (for the VAT number in the duplicate fingerprint) turns a miss into `NULL` and carries on.

## The fence

`src/modules/accounting/services/core/contactDirectoryService.ts` gains
`SupplierNotInCompanyError` (code `SUPPLIER_NOT_FOUND`, added to MCP `REFUSAL_CODES`) and
`assertSupplierInCompany(companyId, supplierId)`. It works like R-067's `assertCustomerInCompany`:

1. every call site runs it **before the first write**, because `withAuth` COMMITs a 4xx;
2. an absent id passes without a query;
3. the read is savepointed, so a malformed id (22P02) is a refusal and the request
   transaction stays usable. Any other error propagates;
4. it checks the tenant only. Unlike `supplierBelongsToCompany` it does not filter
   `deleted_at`, because update paths carry an id the company already owns.

Routes map the typed error to **400** with its own message. Round 2 fixed three that used
`badRequestFromError` and therefore answered the generic "Create failed" / "Action failed":
`batch-payments`, `adjustments` and `bank-rules-action`. The last two map R-067's customer
refusal the same way. Every fenced route's refusal test now also asserts that the body
contains "was not found for this company".

## Census — from the schema, then by consumer

**Columns.** Taken from `information_schema` on the fixture: every column whose name contains
`supplier|vendor|creditor|payee`, plus every column with an FK to `suppliers` under any name.
The FK list is:

```
bank_transactions.predicted_supplier_id   capture_events.resolved_supplier_id
credit_notes.supplier_id                  expected_invoice_alerts.supplier_id
fraud_alerts.supplier_id                  purchase_orders.supplier_id
supplier_activities / _contacts / _coding_history / _coding_rules / _expectations .supplier_id
supplier_invoices.supplier_id             supplier_payments.supplier_id
supplier_purchase_orders.supplier_id      supplier_statement_reconciliations.supplier_id
bank_categorisation_rules (supplier_id, company_id) -> suppliers(id, company_id)   <- the only tenant FK
```

The name-matched columns with no FK are `bank_transactions.suggested_supplier_id`,
`archive_supplier_invoices.supplier_id` and `ap_payment_document_backfill.supplier_id`. The
other name matches hold something else: counters, flags, `*_supplier_invoice_id` (a
different parent) and `sage_supplier_invoices.supplier_name`. Polymorphic columns were
walked again for a supplier arm: `accounting_adjustments.entity_id`,
`procurement_documents.entity_id`, `document_validation_results.entity_id`,
`soft_delete_journal_reversals.entity_id`, `portal_magic_links.contact_id`, plus R-067's
P1–P12.

**Writers.** Each table was searched as a write target (`INSERT INTO` / `UPDATE … SET <col> =`,
single- and multi-line) across `src`, `pages` and `scripts`. Each writer was then walked
back to where its id comes from.

| # | Column | Writer | Where the id comes from | Disposition |
|---|---|---|---|---|
| S1 | `supplier_invoices` | `ap/supplierInvoiceService.ts` `createSupplierInvoice` ← `supplier-invoices.ts` POST, MCP `writeSupplierInvoices` / `writeBulkInvoices`, `sageMigrationCommitService` | body / MCP arg / name resolved in-company | **FIXED** in the service. The route also fences before `reserveNextDocumentNumber`, which is a write |
| S2 | `supplier_invoices` | `core/recurringTransactionInvoices.ts` `mintRecurringSupplierInvoice` | `template_data.supplierId` (opaque JSON) | **FIXED** before `insertWithReservedNumber`; `recurring-transactions-execute.ts` maps to 400 |
| S3 | `supplier_invoices` | `capture/[id]/post.ts`, `ai-invoice-pipeline.ts` | `matchSupplierFromExtraction` over `suppliers WHERE company_id` | exempt: produced by a company-scoped read |
| S4 | `supplier_invoices` | `ap/migrationApService.ts` `importAPInvoices` | page override checked against this company's suppliers (`:77-82`), else name match | already guarded |
| S5 | `supplier_invoices` | `core/sageSupplierInvoiceImportService.ts` `importSupplierInvoices` | it SELECTs `sage_supplier_invoices.supplier_id`, **a column that does not exist** (the table has `id, sage_id, invoice_number, supplier_name, invoice_date, total_amount, gl_supplier_invoice_id, migration_status, imported_at, company_id`) | no reachable write: the function fails 42703 on its first query, before it writes anything, so no request body can reach the column. Round 1 said it read an existing staging column. It doesn't (blind review, r1 LOW-2) |
| S6 | `supplier_invoices`, `supplier_payments`, `supplier_purchase_orders` | `supplier-merge.ts`, `core/duplicateMergeService.ts` | merge ids | already guarded: both ids read `WHERE company_id` first |
| S7 | `purchase_orders` | `purchase-orders.ts` POST (inline) | `body.supplierId` | **FIXED** before the number reservation |
| S8 | `purchase_orders` | `purchase-orders/[id].ts` PUT | `body.supplier_id` | **FIXED** before the UPDATE |
| S9 | `supplier_purchase_orders` | `ap/purchaseOrderService.ts` `createPurchaseOrder` / `updatePurchaseOrder` ← `supplier-purchase-orders.ts` | body | **FIXED** in both; create runs it before `generateOrderNumber` (a counter write) |
| S10 | `supplier_payments` | `ap/supplierPaymentService.ts` `createSupplierPayment` ← `supplier-payments.ts` POST, MCP `writeSettleByContra` | body | **FIXED**; the route maps to 400 (it answered every error 500) |
| S11 | `supplier_payments` | `ap/batchPaymentService.ts` `createBatch` ← `batch-payments.ts` POST | `body.payments[].supplierId` | **FIXED**: every supplier checked before the batch row |
| S12 | `supplier_payments` | `ap/supplierAutoAllocate.ts` `recordSupplierBankPayment` ← `bankAllocationService.allocateTransaction` ← `bank-transactions-action.ts` allocate | body `entityId` | **FIXED** in `allocateTransaction`, right after the row lock, next to R-067's customer arm |
| S12b | same, plus the bank line itself | `bank-transactions-manual.ts` POST: step 1 INSERTs `bank_transactions`, step 2 calls `allocateTransaction` | body `entityId` | **FIXED (r2)**. Round 1 missed this caller. Its refusal came from the service fence AFTER the step-1 INSERT and was answered 500, so only the rollback kept the manual line out; mapping it to 400 there would have committed that line. The route now refuses both the supplier and the customer arm before step 1 and answers 400 with the typed message; the test asserts zero bank rows for B's entity (blind review, r1 LOW-1) |
| S12c | `supplier_payments` | `bank-match-confirm.ts` purchase-order arm → `allocateTransaction` | the matched PO's `supplier_id`, read `WHERE company_id` | exempt: produced by a company-scoped read, fenced where it enters (S7/S8). A PO planted before this fix reaches the service fence and answers a generic 500 with nothing written (reviewer measurement). Noted, not changed |
| S13 | `supplier_payments` | `bankRuleAutoPostLine` → `recordSupplierBankPayment` | the rule's `supplier_id` | exempt: the tenant FK on `bank_categorisation_rules` guarantees it |
| S14 | `supplier_payments` | `ap/supplierBankPaymentService.ts` `applyBankLineToSupplierInvoices` | `planSupplierAllocationLines`, from bills read `WHERE company_id` | exempt: produced by a company-scoped read |
| S15 | `bank_categorisation_rules` | `bank/bankRulesService.ts` `createRule` / `updateRule` | body | the database already refused (tenant FK), with a 23503: POST answered 500 and update answered a generic 400 after a poisoned statement. **FIXED** so it is refused typed, before the write. `bank-rules.ts` maps to 400 |
| S16 | `credit_notes` | `ar/creditNoteService.ts` `createCreditNote` | body | already guarded: `validateCreditNoteLinks` reads the supplier `WHERE company_id` |
| S17 | `credit_notes` | `supplier-returns.ts` POST (inline) | `body.supplierId` | **FIXED** before `reserveNextDocumentNumber` |
| S18 | `accounting_adjustments.entity_id` (supplier) | `items/adjustmentService.ts` `createAdjustment` | body | **FIXED**: the arm R-067 P1 left to this item |
| S19 | `supplier_activities` | `supplier-activities.ts` POST | body | **FIXED** |
| S20 | `supplier_contacts` | `supplier-contacts.ts` POST | body | **FIXED** before the `is_primary` UPDATE |
| S21 | `supplier_coding_rules` | `capture/supplierRulesService.ts` `upsertRule` ← `supplier-rules` POST (body), `supplier-rules/[supplierId]` PATCH (URL) | caller | **FIXED** in the service; both routes map to 400 |
| S22 | `supplier_coding_rules`, `supplier_coding_history` | `supplierRulesService.recordCoding` ← capture post / AI pipeline | the S3 match | exempt: produced by a company-scoped read |
| S23 | `supplier_expectations` | `capture/expectationEngineService.ts` `recomputeForSupplier` ← `supplier-expectations` POST (body) and `recomputeAllForCompany` (the cron) | body / `supplier_invoices.supplier_id` | **FIXED** in the service; the route maps to 400. The cron catches per supplier, so a bill planted before this fix no longer seeds an expectation |
| S24 | `expected_invoice_alerts` | `missingInvoiceChaseService.detectGaps` | `supplier_expectations`, read `WHERE company_id` | fenced where it enters (S23). Pre-existing rows: see the disclosure section |
| S25 | `bank_transactions.suggested_supplier_id` | `bank-transactions-action.ts` save_selection | body | **FIXED** |
| S26 | `bank_transactions.suggested_supplier_id` | `bankRulesSuggestionPass.ts`, `bankRuleAutoPostLine.ts`, `bank-transactions-import-classified.ts` | a rule's `supplier_id` / NULL | exempt: tenant FK |
| S27 | `bank_transactions.predicted_supplier_id` | `capture/provisionalPostingService.ts` | fuzzy match over `suppliers WHERE company_id` | exempt: produced by a company-scoped read |
| S28 | `supplier_statement_reconciliations` | `supplierStatementReconService.createReconciliation` ← `supplier-statements` POST | body | already guarded (`supplier-statements/index.ts:71-78`, before the first INSERT) |
| S29 | `fraud_alerts` | `capture/supplierGraphService.ts` `upsertAlert` | `suppliers WHERE company_id` | exempt: produced by a company-scoped read |
| S30 | `archive_supplier_invoices` | `core/archiveExecutionService.ts` | `INSERT … SELECT` from the company's own bills | exempt: copies rows (the impact query covers the source) |
| S31 | `capture_events.resolved_supplier_id`, `ap_payment_document_backfill.supplier_id` | none in app code | — | no writer (the backfill table is written only by migration 615) |
| S32 | `procurement_documents.entity_id` | `documents.ts` → `verifyEntityOwnership` | — | no supplier arm: it admits only documents, read `WHERE company_id` |

Supplier ids inside JSONB other than `recurring_transaction_templates.template_data` cannot be
listed from `information_schema`. That is a limit of this census; nothing here shows it is safe.

## Does any path render supplier details outside `withAuth`? Yes: one, and it is dormant

Method, in three parts:
1. **API routes.** Take every API route whose default export is not wrapped in `withAuth` /
   `withUserAuth` / `withRole` / `withBearer*` / `withExtensionToken` (crons, portal,
   webhooks, inbound capture, audit portal, invitations, health), walk its static import
   closure, and read every `FROM/JOIN suppliers` in that closure.
2. **getServerSideProps pages** (round 1 left these out; blind review r1 LOW-2):
   `oauth/authorize`, `afs/sign/[token]`, `portal/invoice/[token]`, `reports/report-packs`,
   `afs/portal/dashboard`, `afs/[documentId]`, `afs/portal/documents/[documentId]`,
   `share/[token]`. Walked the same way. Only `afs/[documentId]` has supplier SQL in its
   closure (`apAgingService`, `creditNoteService`), and it comes from the page's client
   components. Its getServerSideProps only `fetch`es a `withAuth` API with the caller's cookies.
3. **The BYPASSRLS pool outside platform admin** (also missed in round 1):
   `workbench/portfolioWorkbenchService.ts` runs `getMonthEndWorkbench` for each of the
   user's companies on `getPlatformAdminPool()`. That reaches `getAPAging` and its id-only
   `JOIN suppliers`. The only output is `buildPurchasesCard`'s total, overdue figure and
   `buckets.length` (`monthEndWorkbenchService.ts:121-131`). No supplier name or contact
   reaches the page.

MCP runs as `app_user` in `bearerPipeline`, so RLS covers it. Platform-admin routes bypass RLS
by design and are out of the tenant model.

- `/api/cron/fraud-scan`: reads suppliers `WHERE company_id` only. Not affected.
- `creditNotePdfBuilder` shows up in several closures through the `ar/index.ts` barrel.
  Its supplier join already carries `s.company_id = cn.company_id`, and only a `withAuth`
  route calls it.
- **`/api/cron/expectations-daily` → `expectationCronService` → `missingInvoiceChaseService`
  / `whatsAppChaseService`.** This runs as the connection role, outside RLS. It learns a
  cadence for every `supplier_id` on the company's bills, raises alerts, and, when the
  company has `chase_auto_send_enabled`, emails or WhatsApps the supplier on the alert.
  All five supplier joins on that path (`autoChaseOverdue`, `listAlerts` ×2,
  `sendEmailChase`, `sendWhatsAppChase`) joined `suppliers` by id alone. **Measured on the
  fixture as the connection role**, with bills and an alert planted for B's supplier under A:
  `listAlerts(A)` returned `"supplierName":"R068 Supplier B","supplierEmail":"b@r068.test"`,
  and `sendEmailChase` / `sendWhatsAppChase` both sent (recorded by mocked transports) to B's
  supplier. The email path then writes the address into **A's own** alert row
  (`chase_to_address`), which A reads through its own UI under RLS. That is R-066's shape on
  the supplier side.

  **Why it is not live.** `systemctl list-timers --all` on velo-server on 2026-09-14 lists
  no `isaflow-expectations` timer, and the route requires `CRON_SECRET`. The unit files are
  in `scripts/`, but they are not installed. The manual chase button runs under `withAuth`,
  where RLS hides B's supplier and the inner join finds no alert. So production has no live
  disclosure today. Installing that timer would have made one.

  **Fixed anyway**, because the R-066 fix was the same one predicate: each of the five joins
  now carries `AND s.company_id = a.company_id`, and S23 stops the cron learning a foreign
  supplier in the first place.

## Tests

All integration runs used the fixture:
`source <scratchpad>/fixture.env && bunx vitest run --config vitest.integration.config.ts --no-file-parallelism <files>`
(each file calls `assertDisposable()`, which accepts only `isaflow_schema_fixture` on localhost).
The fixture companies are random per run and deleted in `afterAll`. The leftover count of
`R068 %` companies read 0 after every run.

| File | What it pins |
|---|---|
| `tests/integration/supplier-ownership-fence-documents.int.test.ts` (27) | S1, S2, S7–S12b, S17 through the real handlers (S12b both arms: B's supplier/customer leaves zero manual bank rows): B's supplier gets 400 and 0 rows under A; A's own supplier gets 2xx and exactly one row. Also: a refused bill with `useSequence` burns no SIV number; a non-UUID template `supplierId` gets 400 with nothing written and the schedule not advanced; the refused allocation posts no journal |
| `tests/integration/supplier-ownership-fence-satellites.int.test.ts` (18) | S15, S18–S21, S23, S25 through the real handlers, both directions |
| `tests/integration/supplier-ownership-fence-services.int.test.ts` (9) | the paths no route reaches: the cron's recompute learns no foreign supplier; `listAlerts` (both queries) does not render B's supplier; email and WhatsApp chases on the planted alert send nothing and copy no address, while A's own supplier is still chased by both; `createSupplierInvoice` refuses directly (MCP reaches it past no route); `updateRule` refuses with the typed error, not the 23503; a malformed id leaves a real request transaction usable |
| `tests/unit/services/assertSupplierInCompany.test.ts` (6) | the contract: both ids bound, typed refusal, no query for an absent id, savepoint name ≤ 31 chars, 22P02 becomes the refusal, any other error propagates |

Six existing unit suites now stub `assertSupplierInCompany`, because they pin behaviour after
the fence and their `sql` queues are positional: `supplierInvoiceService`,
`ap/supplierInvoiceExactTaxAmount`, `supplierPaymentService`, `capture/supplierRulesService`,
`capture/expectationEngineService`, `api/supplierInvoiceClientTaxAmount`.
`bank/supplierBankLineDocument` instead queues an ownership row for the supplier arm, as it
already did for R-067's customer arm. No assertion was removed or loosened.

## Mutations

Each line was removed or reverted in the file, the owning integration file was run, and
the file was restored from a copy with its sha256 checked. All 37 round-1 mutations and all 6
round-2 mutations went red:

| # | Mutation | Result |
|---|---|---|
| M1 | `createSupplierInvoice` fence | services 1 failed: the direct call resolved instead of rejecting |
| M2 | `supplier-invoices.ts` route fence (service fence still in) | docs 1 failed: SIV counter `[5]` not `[4]`; the refusal came after the number was burnt |
| M3 / M4 | `purchase-orders` POST / `[id]` PUT fence | docs 1 failed each: `expected 201/200 to be 400` |
| M5 / M6 | `purchaseOrderService` create / update | docs 1 failed each |
| M7 / M8 | `createSupplierPayment` fence / its route 400 mapping | docs 1 failed each (the mapping mutant answers 500) |
| M9 / M10 | `createBatch` fence / `supplier-returns` fence | docs 1 failed each |
| M11 | recurring bill fence | docs 2 failed: B's template mints a bill; the non-UUID template answers 500 |
| M12 | recurring route mapping | docs 2 failed: both refusals `expected 500 to be 400` |
| M13 | `allocateTransaction` supplier fence | docs 2 failed: the cross-tenant allocation posts, then A's own finds the line already allocated |
| M14 / M15 | activities / contacts fence | sat 1 failed each |
| M16 | `upsertRule` fence | sat 2 failed (POST and PATCH) |
| M17 / M18 | supplier-rules POST / PATCH mapping | sat 1 failed each (500) |
| M19 / M19b | `recomputeForSupplier` fence (route / cron) | sat 1 failed; services 1 failed: `expected 1 to be 0` expectations for B's supplier |
| M20 | expectations route mapping | sat 1 failed (500) |
| M21 | save_selection supplier arm | sat 1 failed |
| M22 | adjustment supplier arm | sat 1 failed |
| M23 | `createRule` supplier fence | sat 1 failed: 500 with the raw FK-violation text in the body |
| M24 | `updateRule` supplier fence | services 1 failed: a 23503 error, not `SupplierNotInCompanyError` |
| M25 | `bank-rules.ts` mapping | sat 1 failed (500) |
| M26 / M27 | `listAlerts` join, filtered / unfiltered | services 1 failed each: the list contains `b@r068.test` |
| M28 / M29 | `sendEmailChase` / `sendWhatsAppChase` join | services 1 failed each: `sent` true |
| M30 | fence `withSavepoint` → plain call | services 1 failed: the malformed-id case aborts the request transaction |
| M31 | fence `throw` disabled | docs 13 failed |
| M32–M36 | 400 mapping in `purchase-orders.ts`, `[id].ts`, `supplier-returns.ts`, `supplier-activities.ts`, `supplier-contacts.ts` | 1 failed each (500) |
| R1 / R2 | `bank-transactions-manual` supplier / customer pre-INSERT fence (r2) | docs 1 failed each: the service's refusal after step 1 answers 500, not 400 |
| R3 | its 400 mapping | docs 2 failed (both arms, 500) |
| R4 / R5 / R6 | typed message in `batch-payments` / `adjustments` / `bank-rules-action` (r2) | 1 failed each: the body says "Create failed" / "Action failed", not the refusal |

Not covered by a dedicated mutation: the join in `expectationCronService.autoChaseOverdue`.
It only selects which alerts to try, and the sends it delegates to are fenced (M28/M29).
Covering it would mean exporting the function or running the all-company cron against the
shared fixture.

## Gates

See the commit report for the pasted final lines of `env -u DATABASE_URL bun run ci` and the
integration run.

## Production impact — for Hein to run (not run here)

Run it as an owner or superuser: forced RLS hides cross-tenant rows from `app_user`. It
lists every row whose supplier belongs to a different company, or to none.

```sql
SELECT t.tbl, t.id, t.company_id, t.supplier_id, s.company_id AS supplier_company_id
  FROM (
    SELECT 'supplier_invoices' AS tbl, id, company_id, supplier_id FROM supplier_invoices
    UNION ALL SELECT 'archive_supplier_invoices', id, company_id, supplier_id FROM archive_supplier_invoices
    UNION ALL SELECT 'purchase_orders', id, company_id, supplier_id FROM purchase_orders
    UNION ALL SELECT 'supplier_purchase_orders', id, company_id, supplier_id FROM supplier_purchase_orders
    UNION ALL SELECT 'supplier_payments', id, company_id, supplier_id FROM supplier_payments
    UNION ALL SELECT 'credit_notes', id, company_id, supplier_id FROM credit_notes
    UNION ALL SELECT 'accounting_adjustments', id, company_id, entity_id
                FROM accounting_adjustments WHERE entity_type = 'supplier'
    UNION ALL SELECT 'supplier_activities', id, company_id, supplier_id FROM supplier_activities
    UNION ALL SELECT 'supplier_contacts', id, company_id, supplier_id FROM supplier_contacts
    UNION ALL SELECT 'supplier_coding_rules', id, company_id, supplier_id FROM supplier_coding_rules
    UNION ALL SELECT 'supplier_coding_history', id, company_id, supplier_id FROM supplier_coding_history
    UNION ALL SELECT 'supplier_expectations', id, company_id, supplier_id FROM supplier_expectations
    UNION ALL SELECT 'expected_invoice_alerts', id, company_id, supplier_id FROM expected_invoice_alerts
    UNION ALL SELECT 'supplier_statement_reconciliations', id, company_id, supplier_id
                FROM supplier_statement_reconciliations
    UNION ALL SELECT 'fraud_alerts', id, company_id, supplier_id FROM fraud_alerts
    UNION ALL SELECT 'bank_transactions.suggested', id, company_id, suggested_supplier_id FROM bank_transactions
    UNION ALL SELECT 'bank_transactions.predicted', id, company_id, predicted_supplier_id FROM bank_transactions
    UNION ALL SELECT 'capture_events', id, company_id, resolved_supplier_id FROM capture_events
  ) t
  LEFT JOIN suppliers s ON s.id = t.supplier_id
 WHERE t.supplier_id IS NOT NULL
   AND (s.id IS NULL OR s.company_id <> t.company_id)
 ORDER BY 1, 3;

-- Chases that reached another tenant's supplier, and which companies ever enabled auto-chase.
SELECT a.id, a.company_id, a.supplier_id, s.company_id AS supplier_company_id,
       a.chase_method, a.chase_to_address, a.chased_at
  FROM expected_invoice_alerts a
  JOIN suppliers s ON s.id = a.supplier_id
 WHERE s.company_id <> a.company_id AND a.chased_at IS NOT NULL;
SELECT id, name, chase_auto_send_enabled, whatsapp_chase_enabled
  FROM companies WHERE chase_auto_send_enabled OR whatsapp_chase_enabled;
```

Both were syntax-checked on the fixture (0 rows there). A `recurring_transaction_templates`
row naming a foreign supplier would not show above: its id is inside `template_data`. From
this commit on, execute refuses such a template with a 400.

## Residual risk

- Rows planted before this commit stay where they are. The fences stop new writes, and the
  chase joins stop the one outside-RLS reader, but the historical rows need the query above.
- JSONB supplier ids other than `template_data` are not enumerable (see Census).
- The MCP tools keep their own `supplierBelongsToCompany` pre-checks, which filter
  `deleted_at`. That is deliberate: they answer a different question for new documents.
