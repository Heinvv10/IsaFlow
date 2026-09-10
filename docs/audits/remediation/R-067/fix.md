# R-067 — an AR document could be booked against another company's customer

**Branch** `fix/audit-r067-invoice-customer-ownership` · from `origin/master` @ `ec669170e`
**Severity** HIGH (security, cross-tenant write) · **Migration** none

## Trigger

`pages/api/accounting/customer-invoices-create.ts` takes `clientId` from the request
body, checks only that it is present, and hands it to `createDraftCustomerInvoice`,
which writes it into **both** `customer_invoices.customer_id` and `client_id`.

Nothing checked that the customer belongs to the company:

- `customer_invoices.client_id` has **no foreign key at all**;
- `customer_id`'s FK references `customers(id)` and is **tenant-agnostic**;
- the RLS `WITH CHECK` on `customer_invoices` only tests the **invoice's own**
  `company_id`, which is taken from the session, not from the customer.

Authenticated *reads* are protected (`customers` has FORCED RLS with a
`tenant_isolation` policy for `app_user`, the role `withAuth` switches to). The
exposure is the customer-portal PDF route, which runs without `withAuth` as the
superuser `postgres` and therefore outside RLS: a planted foreign customer prints
its name, VAT number and billing address on a customer-facing tax invoice (that
read side is registered separately as R-066 / K-091). This fix closes the write
side, which is what makes the planted row possible.

A helper for exactly this check — `customerBelongsToCompany` — has existed since
the MCP write tools were built, and **only the MCP layer ever called it**. Every
HTTP route went straight to the service. That is the same shape the credit-note
fix called out in `creditNoteLinkService.ts:8-10`: *"a check in the MCP tool alone
left that route open"*.

## Before / after

The fence is now a service-level assertion both layers share, next to the boolean
it wraps, in `src/modules/accounting/services/core/contactDirectoryService.ts`:

```ts
export class CustomerNotInCompanyError extends Error { readonly code = 'CUSTOMER_NOT_FOUND'; }

export async function assertCustomerInCompany(
  companyId: string,
  customerId: string | null | undefined,
): Promise<void>
```

Three properties matter:

1. **It runs before the first write.** `withAuth` COMMITs a 4xx returned *after* a
   write, and three of the guarded paths burn a document number (an UPDATE of
   `company_document_numbers`) as their very first statement. Every call site
   places the assertion ahead of that.
2. **An absent id is not a refusal.** `customer_invoices.client_id`,
   `customer_quotes.client_id`, `customer_sales_orders.customer_id` and the
   recurring-transaction template's `clientId` are all nullable and legitimately
   empty — `quoteConvertService` and `salesOrderWorkflowService` both insert
   `|| null`. The guard returns without querying for a falsy id.
3. **The read takes a SAVEPOINT.** A malformed id raises 22P02, which aborts the
   request transaction; a caller mid-batch (`bulk_create_customer_invoices`) would
   then see 25P02 on every later statement instead of this refusal. The 22P02 case
   is turned into the refusal (a non-UUID is by definition not a customer of this
   company); every other error propagates, so a connection failure is never
   reported as "not found". Same pattern as `customerInvoiceCreateService.ts:96`.

4. **It asks about the tenant, not about `deleted_at`.** Round 1 filtered
   `deleted_at IS NULL` (inherited from `customerBelongsToCompany`). That made the
   fence stricter than the guard it cites as its precedent,
   `customer-invoices-detail.ts:104-110`, which has no such clause — and four of the
   call sites are updates or an execute that take the id from a row the company
   ALREADY owns, while `softDeleteService.ts:69-73` soft-deletes a customer with no
   check for open documents. Measured on `isaflow_dev`, driven end to end: with the
   clause, `updateQuote` on a draft quote whose own-company customer had been
   soft-deleted raised `CustomerNotInCompanyError` — a save that worked before this
   fix existed, refused for a reason that closes no cross-tenant exposure. The fence
   now runs its own tenant-only read; `customerBelongsToCompany` /
   `customersBelongToCompany` keep their `deleted_at` filter, because the MCP write
   tools use them to decide whether a NEW document may name a customer, which is a
   different question. `tests/integration/customer-ownership-fence.int.test.ts` pins
   both halves: the soft-deleted own customer still saves, company B's is still
   refused on the same update path.

Routes map the typed error to a 400 the caller can act on.

## Census

Enumerated from the **tables** (`customer_invoices`, `recurring_invoices`,
`customer_quotes`, `customer_sales_orders`, `credit_notes`, `customer_payments`,
`practice_clients`), not from a grep for one spelling: every `INSERT INTO` and
every `UPDATE … SET` touching a customer-id column, then the call graph **through**
the intermediaries (`quoteConvertService`, `salesOrderWorkflowService`,
`recurringInvoiceService.runOneTemplate`, `practiceWipService → wipInvoiceNumber`)
back to where the id first enters. Directories walked: `services/ar`,
`services/ap`, `services/core`, `services/practice`, `services/bank`,
`src/modules/admin/services`, `src/lib/mcp/tools`, `pages/api/accounting/**`,
`pages/api/portal/**`.

**That row set was chosen, not derived, and it was too small.** Rounds 1–2 walked
the write sites of the seven tables named above; `isaflow_dev` has 25 columns named
`client_id` / `customer_id` / `link_customer_id`. Round 3 (below) re-derives the
census from `information_schema` and supersedes the scope of the table that follows;
its rows 1–23b stand as measured.

| # | Write path | Where the id comes from | Disposition |
|---|---|---|---|
| 1 | `ar/customerInvoiceCreateService.ts:126` (`createDraftCustomerInvoice`) | request body `clientId` (route) / MCP arg | **FIXED** — assert before `reserveNextDocumentNumber` |
| 2 | `ar/recurringInvoiceService.ts:92` (`createRecurringInvoice`) | request body `clientId` | **FIXED** — the runner re-mints an invoice from this template every period |
| 3 | `ar/quoteService.ts:187` (`createQuote`) | request body `clientId` | **FIXED** — `convertToInvoice` copies it onto the invoice verbatim |
| 4 | `ar/quoteService.ts:216` (`updateQuote`) | request body `clientId` | **FIXED** |
| 5 | `ar/salesOrderService.ts:228` (`createSalesOrder`) | request body `customer_id` | **FIXED** — `convertSalesOrderToInvoice` copies it onto the invoice |
| 6 | `ar/salesOrderService.ts:267` (`updateSalesOrder`) | request body `customer_id` | **FIXED** |
| 7 | `ar/customerPaymentService.ts:146` (`createCustomerPayment`) | request body `clientId` | **FIXED** — allocations were company-scoped, `client_id` was not |
| 8 | `core/recurringTransactionService.ts:171` (`executeRecurring`) | `template_data` JSONB — opaque, caller-supplied when the template was saved | **FIXED** — the template row is company-scoped, the id inside its JSON is not |
| 9 | `practice/practiceClientService.ts:153,189` (`create/updatePracticeClient`) | request body `linkCustomerId` | **FIXED** — becomes `customer_id` on every WIP invoice (#15) |
| 10 | `pages/api/accounting/customer-invoices-detail.ts:137` (PUT) | request body `clientId` | **already guarded** (`:104-110`, inside the same tx, before the UPDATE) |
| 11 | `pages/api/accounting/time-entries-invoice.ts:90` | request body `customerId` | **already guarded** (`:45-49`, company-scoped + `deleted_at IS NULL`) |
| 12 | `ar/creditNoteService.ts:126` | request body `clientId` | **already guarded** — `validateCreditNoteLinks` (this fix's precedent) |
| 13 | `ar/quoteConvertService.ts:98,44` | `getQuote(companyId, id).clientId` | **exempt** — company-scoped read; fenced at #3/#4 |
| 14 | `ar/salesOrderWorkflowService.ts:48` | `getSalesOrder(companyId, …).customerId` | **exempt** — company-scoped read; fenced at #5/#6 |
| 15 | `practice/wipInvoiceNumber.ts:63` (`insertWipInvoice`) | `practice_clients.link_customer_id`, read company-scoped | **exempt** — fenced at #9, where it enters |
| 16 | `ar/recurringInvoiceService.ts:206` (`runOneTemplate`) | `lockRecurringTemplate(companyId, id).client_id` | **exempt** — company-scoped read; fenced at #2 |
| 17 | `core/migrationImportService.ts:125` | `matchContact(name, …)` over `customers WHERE company_id = …` | **exempt** — the id is *produced* by a company-scoped lookup, never supplied |
| 18 | `admin/sageMigrationCommitService.ts:163` | `resolveCustomerId(companyId, inv.customerName)` | **exempt** — same, resolved by name within the company |
| 19 | `core/sageCustomerImportService.ts:66` | `sage_customer_invoices.client_id`, staging row read `WHERE company_id = …` | **exempt** — trusted import context; the staging row was written for this company by the Sage sync. Noted rather than blanket-fixed: adding the assert here would be a no-op for a legitimate import, but it is an admin-triggered migration path, not a user-facing route |
| 20 | `core/duplicateMergeService.ts:50` | merge target id | **exempt** — validates **both** ids against `customers WHERE company_id` first (`:36-43`) |
| 21 | `pages/api/accounting/customer-merge.ts:56` | merge target id | **exempt** — same check inside the tx (`:43-51`) |
| 22 | `mcp/writeBulkCustomerInvoices.ts`, `writeInvoices.ts`, `bankRuleShared.ts`, `writeContacts.ts` | MCP args | **exempt** — already call `customerBelongsToCompany`; the service-level assert is now a second, unavoidable fence |
| 23 | `bank/bankAllocationService.ts:425` (`allocateTransaction`, customer arm) | request body `entityId` — **NOT** derived from anything company-scoped | **FIXED (round 2)** — the round-1 exemption was wrong; see below |
| 23b | `ar/gatewayInvoiceReceiptService.ts:157` | `customer_invoices.client_id` of an invoice read `WHERE company_id` | **exempt** — id produced by a company-scoped read |

### Row 23 was wrong, and it cost a measured cross-tenant write

`entityId` is a plain parameter of `allocateTransaction` and arrives straight from
the request body: `pages/api/accounting/bank-transactions-action.ts:40` validates it
as `UUID.optional()` and `:118` passes `body.entityId` through unchanged. The only
customer read on the path (`:283`) fetches a NAME and, on a miss, falls back to
`` `Customer #${entityId}` `` and continues; the id then lands in
`INSERT INTO customer_payments (company_id, client_id, …)`.

Measured on `isaflow_dev` by removing the new fence from a file copy and driving the
service end to end — company A allocating a +R115 receipt with company B's customer:

```
customer_payments: company_id=…f0671 (A)  client_id=…f0674 (B)
                   customer_company_id=…f0672 (B)  total_amount=115.00
```

With the fence in place the same call raises `CustomerNotInCompanyError`, no journal
is posted, no payment row is written and the bank transaction stays `imported`.

The fence sits in `allocateTransaction` itself, immediately after the row lock and
before `createJournalEntry`: every caller reaches the write through this one function
— `bank-transactions-action.ts`, `bank-transactions-manual.ts`, `bank-match-confirm.ts`,
`ar/receipt-match/confirm.ts`, `autoPostGateService.sweep`, `bankRuleAutoPostLine`,
`receiptMatchConfirmService`, and the MCP `allocate_bank_transaction` /
`bulk_allocate_bank_transactions` tools through `allocationLine.postAllocationLine`.
The MCP layer was **not** in fact unguarded: `writeBankAllocate.ts:60` and
`bulkAllocationPrepare.ts:107` call `checkLinesOwnership`, which calls
`customersBelongToCompany` — the plural spelling is why a search for
`customerBelongsToCompany` missed it. The HTTP routes had nothing.

### Round 2 — every exemption re-derived BY OUTCOME

Round 1 argued its exemptions from reading, and one of them was wrong. Each row below
was re-run against `isaflow_dev` with two throwaway companies, feeding company B's
customer id into company A's call and reading the database afterwards. The probe
(kept out of the branch) drove the real HTTP handlers through `withAuth` for the route
rows and the real services for the rest. All fixtures were deleted afterwards; the
`isaflow` production database was never touched.

| # | What was run | Outcome |
|---|---|---|
| 10 | `customer-invoices-detail` PUT through the handler, `clientId` = B's customer, on a draft invoice owned by A | **HTTP 422**; `client_id` unchanged (still A's customer) |
| 11 | `time-entries-invoice` POST through the handler, `customerId` = B's customer | **HTTP 400**; 0 new invoices carrying B |
| 12 | `createCreditNote(A, { clientId: B })` | **refused** — `Error: Not found` from `validateCreditNoteLinks`; no `credit_notes` row |
| 13 | `convertToInvoice` on a quote whose `client_id` was PLANTED as B's | **carried through** — the new invoice's `client_id` is B's |
| 14 | `convertSalesOrderToInvoice` on an order whose `customer_id` was PLANTED as B's | **carried through** |
| 15 | `generateWipInvoice` on a practice client whose `link_customer_id` was PLANTED as B's | **carried through** |
| 16 | `generateInvoiceFromRecurring` on a template whose `client_id` was PLANTED as B's | **carried through** |
| 17 | `matchContact('Census Cust B', <rows read WHERE company_id = A>)` | returned **A's own** customer id — the row set it chooses from is company-scoped, so no foreign id is reachable |
| 18 | the `resolveCustomerId` query, company A + a name that exists only under B | **0 rows** → `Customer not found`, nothing inserted |
| 19 | `sage_customer_invoices` staging | no `INSERT` into that table exists anywhere in the repo (`grep -rn sage_customer_invoices src pages scripts chrome-extension`) — the rows come from the external Sage sync, so no request body reaches `client_id` here. **Not measurable in-repo; stated as such rather than argued.** |
| 20 | `mergeEntities(A, 'customer', A's customer, B's customer)` | **refused** — `One or both customers not found for this company` |
| 21 | `customer-merge` POST through the handler, `source_id` = B's customer | **HTTP 400** — `One or both customers not found or do not belong to this company` |
| 22 | `create_draft_invoice` MCP tool, `customer_id` = B's customer | **`isError: true`, "Not found"**; 0 new invoices carrying B |
| 23 | `allocateTransaction(A, …, 'customer', B's customer)` | round 1: **wrote the cross-tenant row** (above). Round 2: **refused**, nothing posted |

**Rows 13–16 are the honest result and they are not a refusal.** Those four paths copy
a customer id out of a row company A already owns and write it onto a new document
with no re-check. Nothing a caller sends today can plant a foreign id in those source
rows — every entry point that writes them is fenced at #2–#9, which is what the
mutation table below proves — but a row planted BEFORE this commit still propagates.
That is exactly what the historical-impact query at the end of this document is for:
it lists the source rows as well as the documents, and each must be corrected at the
source row, not only on the invoice the conversion produced.

`time-entries-invoice.ts:45-49` keeps its own `deleted_at IS NULL`; that guard is
pre-existing and untouched here, and it is a create path, where refusing a deleted
customer is the same call `customerBelongsToCompany` makes.

### Round 3 — the census re-derived from the SCHEMA

The r2 review measured two cross-tenant writes the table-scoped census could not see
(`createWriteOff`, `createDeliveryNote`) and named four routes taking a body customer
id unfenced. The universe is now the schema, not a list:

```sql
-- isaflow_dev, public schema. Every column whose NAME says it holds a customer or
-- client id, plus every column with an FK to customers under ANY name.
WITH fk AS (
  SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
    JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
   WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'customers')
SELECT c.table_name, c.column_name, (fk.column_name IS NOT NULL) AS fk_customers
  FROM information_schema.columns c
  LEFT JOIN fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
 WHERE c.table_schema = 'public'
   AND (c.column_name ~ '(client|customer)_id$' OR fk.column_name IS NOT NULL);
```

30 rows: the reviewer's 25 (`client_id` / `customer_id` / `link_customer_id`) plus
`bank_transactions.suggested_client_id`, `companies.stripe_customer_id` and three
`practice_client_id` columns. No column FKs `customers` under any other name. Each was
mapped to its writers by searching the table name as a write target (`INSERT INTO`,
`UPDATE`, multi-line, across `src`, `pages`, `lib`, `chrome-extension`), then walking
each writer back to where the id enters. Directories walked in addition to round 1's:
`services/reports`, `services/loans`, `pages/api/accounting/ar/**`,
`pages/api/accounting/practice/**`, `pages/api/portal/**`.

| # | Column | Writer(s) | Where the id comes from | Disposition |
|---|---|---|---|---|
| S1 | `customer_invoices.client_id`, `.customer_id` | rows 1, 10–19, 22, 23b above | — | as above |
| S2 | `customer_payments.client_id` | rows 7, 23 | — | as above |
| S3 | `customer_quotes.client_id` | rows 3, 4 | — | as above |
| S4 | `customer_sales_orders.customer_id` | rows 5, 6 | — | as above |
| S5 | `credit_notes.client_id` | row 12 | — | as above |
| S6 | `recurring_invoices.client_id` | row 2 | — | as above |
| S7 | `practice_clients.link_customer_id` | row 9 | — | as above |
| S8 | `customer_write_offs.client_id` | `ar/writeOffService.ts` `createWriteOff` ← `write-offs.ts` POST | `req.body.clientId`; only `invoiceId` was read company-scoped | **FIXED (r3)** — fence first; the route's existing catch answers 400 |
| S9 | `delivery_notes.customer_id` | `ar/deliveryNoteService.ts` `createDeliveryNote` ← `delivery-notes.ts` POST | `input.customer_id`, presence-checked only | **FIXED (r3)** — fence before `nextDeliveryNoteNumber` (a counter write); route maps the error to 400 |
| S10 | `projects.client_id` | `pages/api/accounting/projects.ts` POST (inline) | `body.clientId` | **FIXED (r3)** — fence before the count read and INSERT, 400 |
| S11 | `customer_activities.customer_id` | `customer-activities.ts` POST (inline); `customer-merge.ts:87` | `body.customerId` / merge ids | POST **FIXED (r3)**; merge already guarded (row 21) |
| S12 | `customer_contacts.customer_id` | `customer-contacts.ts` POST (inline); `customer-merge.ts:71` | `body.customerId` | POST **FIXED (r3)** — fence placed before the `is_primary` UPDATE, which is the first write when `isPrimary` is set; merge guarded (row 21) |
| S13 | `customer_delivery_addresses.customer_id` | `customer-delivery-addresses.ts` POST (inline); `customer-merge.ts:79` | `body.customerId` | POST **FIXED (r3)** — before the `is_default` UPDATE; merge guarded (row 21) |
| S14 | `customer_dunning_overrides.customer_id` | `ar/dunningOverridesService.ts` `setOverride` ← `ar/dunning/overrides/index.ts` POST | `body.customerId` (UUID shape only) | **FIXED (r3)** — fence before the upsert; the route maps it to 404 by TYPE, like its template refusal |
| S15 | `bank_categorisation_rules.client_id` | `bank/bankRulesService.ts` `createRule` / `updateRule` ← `bank-rules.ts` POST, `bank-rules-action.ts` update, MCP `writeBankRules` | `body.clientId` | **FIXED (r3)** in both service functions; MCP already checked `refsBelongToCompany`. `bank-rules-seed.ts:98` inserts no `client_id` |
| S16 | `bank_transactions.suggested_client_id` | `bank-transactions-action.ts` `save_selection` (inline); `bank/bankRulesSuggestionPass.ts:85`; `bankRuleAutoPostLine.ts:214` | `body.selectionEntityId`; a rule's `client_id`; `NULL` | `save_selection` **FIXED (r3)**. The suggestion pass copies a rule's `client_id` — fenced at S15 where it enters; a rule planted before this commit still propagates (impact query). Auto-post writes `NULL` |
| S17 | `time_entries.customer_id` | `core/timeTrackingService.ts` `createTimeEntry` / `updateTimeEntry` ← `time-entries.ts` POST/PUT | `req.body.customerId` | **FIXED (r3)**; the practice time-entry services write `practice_client_id` only (no `customer_id` in either file) |
| S18 | `portal_payment_links.client_id` | `pages/api/portal/payment-link.ts` POST → `portalService.createPaymentLink`; `core/paymentGatewayPortalService.ts:18`; `customer-invoices/[id]/pay-now.ts:96` | `body.clientId`; `ci.client_id` of an invoice read `WHERE company_id` (both others) | POST **FIXED (r3)** — the one PORTAL-facing row: the unauthenticated GET hands the link's `client_id` to anyone with the token. The other two are **exempt** — id produced by a company-scoped read |
| S19 | `archive_customer_invoices.client_id`, `.customer_id` | `core/archiveExecutionService.ts:105` | `INSERT … SELECT` from `customer_invoices WHERE company_id` | **exempt** — copies A's own rows; a planted pre-existing id is carried (impact query covers the source table) |
| S20 | `portal_access.client_id` | `ar/portalService.ts:61` `createPortalUser` | its `input.clientId` | **no caller** — `rg createPortalUser src pages scripts` finds only the definition. Not fenced: it takes no `companyId`, so a fence would need a signature change for code nothing runs. Stated, not argued safe: whoever wires it must add one |
| S21 | `payment_transactions.customer_id` | none | — | **no writer in the repo** (`rg payment_transactions src pages scripts` outside migrations: 0 hits). Not measurable in-repo |
| S22 | `oauth_apps.client_id` (text) | — | an OAuth client identifier | **not a customer id** — name collision |
| S23 | `companies.stripe_customer_id` (varchar) | — | a Stripe id | **not a customer id** |
| S24 | `practice_client_contacts.client_id` | `practice/practiceClientService.ts:258` ← `practice/client-contacts.ts` POST | `body.clientId` — unfenced | **FK is `practice_clients`, not `customers`** — same shape, different parent. Registered as **R-073** (reserved), below |
| S25 | `practice_client_rate_overrides.client_id` | `practice/clients/[id]/rate-overrides.ts` → `practiceClientRateOverrideService` | route `id` | FK `practice_clients`; the routed path checks `assertClientBelongsToCompany` (`:42`) first. The `@deprecated` `practiceStaffRateService.createClientRateOverride` has no route |
| S26 | `time_entries`, `practice_jobs`, `practice_entry_templates` `.practice_client_id` | practice services | — | **not a customer id** — each FKs `practice_clients`, a different parent table; handed to R-073 with S24, whose scope is exactly that table |

Columns a name- or FK-based query cannot find — the polymorphic ones — are walked in
round 4 below (P1–P12); round 3 left four of them "not walked", and one of those was a
live cross-tenant write. Customer ids inside JSONB: `recurring_transactions.template_data`
is row 8; other JSONB is not enumerable from `information_schema`, and that limit is
stated rather than assumed away.

**Measured, end to end.** `tests/integration/customer-ownership-fence-routes.int.test.ts`
drives every r3 site through its real handler — `withAuth`, CSRF, write access — on
`isaflow_dev` with two throwaway companies (random ids, deleted in `afterAll`; a count
of leftover `R067 r3%` companies read 0 after every run). For each: company B's
customer → the refusal status and **0** rows of company A carrying it; company A's own
customer → 2xx and exactly one row carrying it. The refused delivery note also leaves
the document counter untouched. With each fence line removed from a file copy, that
site's own case turns red with the write going through (`expected 201 to be 400` /
`expected 200 to be 400`), and the delivery-note mutant also burns a number
(`expected [ 2 ] to deeply equal [ 1 ]`) — which is the reviewer's measurement,
reproduced from the other side.

The reviewer's grading note stands and is worth keeping precise: none of S8–S17 is
rendered by the portal superuser route today, so their name joins stay inside RLS for
`app_user`. S18 is the exception — portal-facing by construction.

### Round 4 — the polymorphic columns, every one walked

The r3 review measured `accounting_adjustments.entity_id` taking company B's customer
through `adjustments.ts` POST (HTTP 200, row stored under A). Round 3 had listed that
column as "not walked", which is neither a fence nor a reason. Rows P1–P8 below were
found BY NAME PATTERN (`entity_id` / `*_entity_id` / `target_id` / `counterparty_id` in
`information_schema.columns`) — a census by spelling. The r4 review swept FK-less
`*_id` columns instead and found four more polymorphic columns (P9–P12), each read at
its write site here. All twelve are walked to their writers:

| # | Column | Writer(s) | Can it hold a body-supplied customer id? | Disposition |
|---|---|---|---|---|
| P1 | `accounting_adjustments.entity_id` | `items/adjustmentService.ts` `createAdjustment` ← `adjustments.ts:32` POST | yes — `req.body.entityId`; CHECK limits `entity_type` to `customer`/`supplier` | **FIXED (r4)** — `if (entityType === 'customer') assertCustomerInCompany(…)` before the INSERT; the route's catch answers 400 with nothing written. The **supplier arm** is the same shape and goes to **R-068** (supplier twin, already holding `bankAllocationService`'s supplier arm): this is a SCOPE choice, not a blocker — `supplierBelongsToCompany` already exists and could fence it in one line — but the supplier twin is R-068's finding and its sites are fixed together there. A unit case pins that the supplier arm issues no customer read |
| P2 | `procurement_documents.entity_id` | `core/documentStorageService.ts:124` `uploadDocument` ← `documents.ts` POST; `documents.ts:183` UPDATE | no — `documents.ts:118` calls `verifyEntityOwnership` first, which admits only this company's supplier/customer invoices, payments and credit notes; the UPDATE writes `is_active` only, after the same check (`:178`) | **walked, already fenced** |
| P3 | `document_links.linked_entity_id` | `documentStorageService.ts:169-205` `autoLinkSupplierInvoice` | no — writes PO / GRN / supplier-invoice ids read from a supplier invoice already checked by P2 | **walked, not a customer id** |
| P4 | `document_validation_results.entity_id` | `document-validation.ts:113` | no — every `entityType` arm first reads the entity `WHERE company_id` and 404s on a miss; there is no customer arm | **walked, already fenced** |
| P5 | `audit_log.entity_id` | `core/auditTrailService.ts:82` | records the id the request NAMED — an audit trail must keep a refused or foreign id as asked; no reader joins `customers` on it (`rg audit_log … join`: 0) | **walked, exempt by purpose** |
| P6 | `close_run_proposals.target_entity_id` | `gl/closeRun/closeRunRepo.ts:141` ← `closeRunService.ts:72` | no — `closeRunProposalBuilder.ts:75,93` sets it to a journal id from the company's own close run, or `null` | **walked, not a customer id** |
| P7 | `entity_udf_values.entity_id` | `core/udfService.ts:152` `setEntityUdfValues` | its only writer has no caller (`rg setEntityUdfValues`: definition only) | **walked, no caller** |
| P8 | `loans.counterparty_id` | `loans/loanService.ts:107,184` | a caller-supplied uuid, but no FK and no reader resolves it against `customers` or any table (`rg counterparty_id`: loanService's own mapper only; `contraSettlementService`'s is an unrelated alias) | **walked, references nothing** |
| P9 | `gl_journal_entries.source_record_id` (FK-less by design, `gl/.claude.md:84`) | `gl/journalEntryCrudService.ts:245` `createJournalEntry`, from `input.sourceRecordId` | no — the only callers that set it pass a reconciliation id (`bank/bankReconciliationService.ts:171`) or a supplier-invoice id (`reports/drcVatService.ts:88`); `journal-entries.ts:44` destructures the body and never reads `sourceRecordId`; the other three INSERTs (`assetDepreciationPosting.ts:118`, `yearEndJournalPoster.ts:169`, `bank-transfers.ts:78`) do not write the column | **walked, not a customer id** |
| P10 | `approval_requests.document_id` | `gl/approvalDocuments.ts:205` `requestApproval` | no — `resolveApprovalDocument` (`:187`) reads the document `WHERE company_id` by type (invoices, payments, …) and throws `ApprovalDocumentNotFoundError` on a miss before the INSERT; the id is a document, never a customer | **walked, already fenced** |
| P11 | `stock_movements.reference_id` | `pages/api/accounting/stock-adjustments.ts:47` | no — it is the id of the `stock_adjustments` row inserted two statements earlier | **walked, not a customer id** |
| P12 | `flow_ledger.reference_id` | `billing/services/flowWalletService.ts:193`, via `completeBundlePurchase` (`:329`, a purchase id), `deductFlows` / `refundFlows` (`null` from the meters; `bulkImportId` from `bank-transactions-bulk-commit.ts:237,325`) | `bulkImportId` IS a client-minted UUID from the body — but it is an opaque batch-correlation id: `listLedger` returns it raw with no join and the admin PAYG report does not read it, so it names nothing | **walked, references nothing** |
| — | `admin_audit_log.target_id` (varchar) | platform-admin audit | same purpose as P5, and outside the tenant model | **exempt by purpose** |

**Measured.** `adjustments POST (customer)` is a new case in
`customer-ownership-fence-routes.int.test.ts`: B's customer → 400 and 0 rows; A's own →
200 and one row. With the fence commented out (file copy): `1 failed | 28 passed (29)`,
`× 'adjustments POST (customer)' refuses company B's customer and stores nothing` —
`expected 200 to be 400`. The unit file adds the same arm; the fence mutant turns 2 of
its 17 red.

### Round 6 — the merge turned row 8's refusal into a 500

Master's `recurring-transactions-execute.ts` answers a 4xx only for the pre-write errors
it names (NotFound, NotDue, TotalsMismatch) and rethrows the rest, so after the round-5
merge `CustomerNotInCompanyError` from the moved row-8 fence reached `withErrorHandler`
as a masked 500 — for company B's customer and for a non-UUID `clientId` alike (the
reviewer's measurement; nothing was written, a 5xx rolls back). The route now maps it to
**400**: the fence runs before `insertWithReservedNumber`, so the COMMIT a 4xx triggers
commits nothing, which is exactly the class master's own comment admits to a 4xx.

`customer-ownership-fence-routes.int.test.ts` gains row 8's first route-level coverage,
through the real handler with three due templates whose `template_data.clientId` is A's
customer, B's customer, and `"not-a-uuid"`:

| Case | Outcome |
|---|---|
| template naming B's customer | 400; 0 invoices of A carry B |
| template naming A's customer | 200; one invoice carrying A |
| template with `clientId: "not-a-uuid"` | 400; A's invoice count unchanged; the template's `next_run_date` not advanced |

| Mutation (file copy, restored) | Result |
|---|---|
| route mapping → `false` | `2 failed | 30 passed (32)` — both refusals `expected 500 to be 400` |
| fence in `recurringTransactionInvoices.ts` commented out | `2 failed` — B's template `expected 200 to be 400` (the cross-tenant invoice is minted), the non-UUID one `expected 500 to be 400` |

The delivery-note counter case was made order-independent in the same change. It compared
`next_number` with a fixed `[1]`, but any invoice minted earlier in the run seeds every
default counter row (`ensureDocumentNumbers`), so the absolute value depends on test
order — the fence mutant above surfaced it. It now snapshots the counter, makes the
refused call itself, and compares; with the delivery-note fence removed it reads
`expected [ 3 ] to deeply equal [ 2 ]`.

### Reserved, not fixed here

**R-068** — the supplier twin. `ap/supplierInvoiceService.ts:144` writes
`input.supplierId` from the request body into `supplier_invoices.supplier_id`; the
one company-scoped read above it (`:134`) fetches `vat_number` for the duplicate
fingerprint and a miss yields `NULL`, not a refusal. `pages/api/accounting/purchase-orders.ts:42`
does the same with `body.supplierId`. `supplierBelongsToCompany` exists and, again,
only the MCP tools call it. Out of scope here per the brief.

**R-068 also owns `adjustmentService.ts` `createAdjustment`'s supplier arm** (P1 above):
`entity_type = 'supplier'` with a body `entityId`, joined to `suppliers` for the name
and posted against AP control on approval. `supplierBelongsToCompany` already exists,
so nothing blocks the fence; it is deferred because the supplier twin is R-068's scope.

**R-068 also owns `bankAllocationService.ts:246-249`** — the supplier arm of
`allocateTransaction`, identical in shape to the customer arm fixed above:
`entityId` from the request body, a name lookup that falls back to
`` `Supplier #${entityId}` ``, and a `supplier_payments` document created against
this company for another tenant's creditor. The MCP callers are covered
(`checkLinesOwnership` → `suppliersBelongToCompany`); the HTTP routes are not. One
line, `assertSupplierInCompany`-shaped, in the same place — registered rather than
taken here because the supplier twin is R-068's scope.

**R-073** — the practice-client twin (reserved with `reserve-r-id.sh`).
`pages/api/accounting/practice/client-contacts.ts:28` takes `body.clientId` and
`createClientContact` writes it into `practice_client_contacts.client_id` under this
company with no read of `practice_clients`; the FK is tenant-agnostic. The sibling
`rate-overrides.ts:42` shows the check it lacks. It is not a customer id, so it is
registered rather than folded in; R-073 should also walk the three
`practice_client_id` columns (S26).

### Noted, not fixed (pre-existing, unrelated to this finding)

`pages/api/portal/payment-link.ts` POST derives its `companyId` from the user's
DEFAULT `company_users` row rather than the active company `withAuth` resolved. The
r3 fence uses the same `companyId` as the route's own invoice check, so the two agree;
the choice of company is pre-existing and left as found.

`quoteService.ts:87` — `nextQuoteNumber()` reads
`SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1` with
**no `company_id` filter**. RLS keeps it honest for `app_user`, but the query is
wrong on its face and would number quotes from another tenant's sequence on any
path that runs as a superuser. *(Round 5: gone on master — `createQuote` now reserves
through `insertWithReservedNumber`; the fence stays ahead of that reservation.)*

### Round 5 — merge of `origin/master`

Merging master (no rebase) conflicted in eight files. Resolved so every fence still runs
before the first write of its path, re-read after the merge:

- `recurringTransactionService.ts` — master moved the customer-invoice branch of
  `executeRecurring` into `recurringTransactionInvoices.ts` `mintRecurringCustomerInvoice`.
  The row-8 fence moved with it: it now sits in that function right after `clientId` is
  read from `templateData`, before `insertWithReservedNumber` (the first write).
- `customerInvoiceCreateService.ts`, `quoteService.ts`, `recurringInvoiceService.ts` —
  master replaced the inline number reservation with `insertWithReservedNumber`; the
  fences already precede it. The now-unused `reserveNextDocumentNumber` import was dropped.
- `writeOffService.ts`, `adjustmentService.ts` — import-only conflicts
  (`claimUnderLockTimeout` is used by approve, after create's fence).
- `projects.ts` — the fence is kept ahead of master's new MAX-based project numbering.
- `tests/unit/services/ar/quoteService.test.ts` — master's reservation queue, with the
  ownership row still first.
- `tests/unit/services/customerOwnershipFence.test.ts` — master's `executeRecurring` now
  takes a real `FOR UPDATE` on the template (`recurringTemplateLock`), which needs a live
  request transaction; the lock is stubbed to return the due template, and the case
  still asserts the refusal with no write. Commenting out the moved fence in
  `recurringTransactionInvoices.ts` turns it red (`1 failed | 18 passed`).

## Tests

**How the integration files were run.** Both R-067 integration files guard themselves
with `assertNotProductionDb`, which allows only `isaflow_dev` / `isaflow_test` — so they
refuse `isaflow_schema_fixture`, the database `fixture.env` names (EXIT=1, all skipped).
Every integration result in this document came from this exact command, which takes
`JWT_SECRET` from `fixture.env` and overrides `DATABASE_URL` with the `isaflow_dev` URL
from the main checkout's `.env.local`; it never names `isaflow`:

```bash
cd /home/hein/Workspace/IsaFlow/.worktrees/fix-R-067 &&
DEV=$(grep '^DATABASE_URL' ../../.env.local | cut -d= -f2-) &&   # …:7772/isaflow_dev
source <scratchpad>/fixture.env &&                                # for JWT_SECRET only
export DATABASE_URL="$DEV" &&
bunx vitest run --config vitest.integration.config.ts --no-file-parallelism \
  tests/integration/customer-ownership-fence.int.test.ts \
  tests/integration/customer-ownership-fence-routes.int.test.ts
```

| File | What it pins |
|---|---|
| `tests/unit/services/assertCustomerInCompany.test.ts` (7) | the fence itself: owned passes, foreign refuses, absent id issues **no query**, the read is scoped by `company_id` **and asks nothing about `deleted_at`** (`:64` asserts the clause is absent — property 4), savepoint name ≤31 chars, 22P02 → refusal, any other error propagates |
| `tests/unit/services/customerOwnershipFence.test.ts` (19) | per call site, **by outcome**: a foreign id is refused and the ownership SELECT is the *only* statement that ran (no INSERT/UPDATE/DELETE); an own-tenant id gets past the fence into the rest of the path |
| `tests/unit/services/customerOwnershipFenceSatellites.test.ts` (17) | round 3–4's service arms (S8, S9, S14, S15 ×2, S17 ×2, P1): foreign id refused with the ownership SELECT the only statement run; own id proceeds; an update with no customer id, and a supplier adjustment, issue no customer query |
| `tests/integration/customer-ownership-fence-routes.int.test.ts` (32) | rounds 3–6, end to end through the real handlers: all 15 write arms (incl. row 8's recurring execute) refuse B's customer with 0 rows written and still store A's; a non-UUID template `clientId` answers 400 with nothing written; the refused delivery note reserves no document number |
| `tests/integration/customer-ownership-fence.int.test.ts` (6) | against a real database, because the hole *is* the schema: company B's customer is refused and `customer_invoices` is left empty; company A's own customer still creates the invoice with both columns set; a non-UUID is refused **inside a real `als.run` request transaction** which then stays usable; a soft-deleted own customer still edits its draft quote while B's is still refused; a bank receipt allocated to B's customer posts nothing and the same receipt against A's customer allocates |

Two existing suites (`customerInvoiceCreateRetry`, `customerPaymentService`) now stub
`assertCustomerInCompany` — they pin behaviour *after* the fence and their `sql`
mock queues would otherwise shift by one call.

Round 2 adds the same accommodation to the three bank suites the new fence sits in
front of: `bankAllocationSign`, `bank/bankAllocationDateShift` and
`bank/supplierBankLineDocument` gain a `withSavepoint` passthrough in their `@/lib/neon`
mock (it was absent, so the fence's savepoint call was `undefined`), and the two whose
`sql` queue is positional get one ownership row in the customer arm's position. No
assertion in any of them was removed or loosened — and both of those queues stay
mutation-sensitive: reverting the fence line shifts them back and turns them red.

Round 3 does the same for `ar/dunningOverridesService.test.ts`: a `withSavepoint`
passthrough and one ownership row at the head of each `setOverride` queue. Reverting
the `setOverride` fence turns 5 of its 8 tests red.

## Mutations

Every guard line reverted one at a time from file copies, gates re-run, line restored:

| Mutation | Result |
|---|---|
| `quoteService.ts:184` (create) | 1 failed |
| `quoteService.ts:216` (update) | 1 failed |
| `recurringInvoiceService.ts:77` | 2 failed |
| `salesOrderService.ts:226` (create) | 1 failed |
| `salesOrderService.ts:268` (update) | 1 failed |
| `customerPaymentService.ts:110` | 1 failed |
| `customerInvoiceCreateService.ts:62` | 1 failed |
| `recurringTransactionService.ts:173` | 1 failed |
| `practiceClientService.ts:147` (create) | 2 failed |
| `practiceClientService.ts:183` (update) | 1 failed |
| `contactDirectoryService.ts` — the `throw` disabled | 12 failed |
| `customerInvoiceCreateService.ts:62`, **integration** | 2 failed — and the cross-tenant invoice **was actually written**, which is the direct proof of the defect |

### Round 2 mutations

| Mutation (file copy, restored) | Result |
|---|---|
| `bankAllocationService.ts:123` — the fence line commented out | integration **1 failed**; a witness probe on the same mutation printed the row that was written: `company_id=…f0671 (A) client_id=…f0674 (B) customer_company_id=…f0672 (B) total_amount=115.00` |
| `assertCustomerInCompany` — `withSavepoint(...)` replaced by a plain call | integration **1 failed** — the malformed-id case now sees the raw 22P02 escape and the request transaction abort. Under the round-1 test (no ALS store) the same mutation left all 3 tests green, which is the LOW the reviewer raised |
| `assertCustomerInCompany` — `AND deleted_at IS NULL` put back | integration **1 failed** — `CustomerNotInCompanyError` on a draft quote whose own-company customer was soft-deleted. This is the end-to-end measurement behind property 4 |

### Round 3 mutations

Each line commented out (or its error mapping disabled) in a file copy, the file
restored with `cp`, `git status --porcelain -uall` unchanged afterwards. "Int" is
`customer-ownership-fence-routes.int.test.ts` on `isaflow_dev`; "Unit" is
`customerOwnershipFenceSatellites.test.ts`.

| Mutation | Int (27) | Unit (14) |
|---|---|---|
| `writeOffService.ts:76` fence | 1 failed — `write-offs POST`: `expected 200 to be 400` | 1 failed |
| `deliveryNoteService.ts:193` fence | 2 failed — `expected 201 to be 400`; counter `[ 2 ]` not `[ 1 ]` | 1 failed |
| `bankRulesService.ts:40` (create) | 1 failed — `bank-rules POST` | 2 failed |
| `bankRulesService.ts:67` (update) | 1 failed — `bank-rules-action update` | 2 failed |
| `dunningOverridesService.ts:73` | 1 failed — `expected 200 to be 404` | 1 failed |
| `timeTrackingService.ts:140` (create) | 1 failed — `time-entries POST` | 2 failed |
| `timeTrackingService.ts:170` (update) | 1 failed — `time-entries PUT` | 1 failed |
| `projects.ts:38` | 1 failed — `expected 201 to be 400` | — |
| `customer-activities.ts:101` | 1 failed | — |
| `customer-contacts.ts:69` | 1 failed | — |
| `customer-delivery-addresses.ts:74` | 1 failed | — |
| `bank-transactions-action.ts:154` | 1 failed — `save_selection` | — |
| `portal/payment-link.ts:80` | 1 failed | — |
| `delivery-notes.ts:70` — 400 mapping disabled | 1 failed — `expected 500 to be 400` | — |
| `bank-rules.ts:72` — 400 mapping disabled | 1 failed — `expected 500 to be 400` | — |
| `ar/dunning/overrides/index.ts:62` — 404 mapping disabled | 1 failed — `expected 500 to be 404` | — |

In every row the case that failed is the mutated site's own; no other case moved.

## Historical impact — for Hein to run

Production was **not** queried. The write side is closed from this commit; existing
rows are not touched. Run against `isaflow`:

```sql
-- AR documents whose customer belongs to a DIFFERENT company (or to none).
SELECT 'customer_invoices' AS doc, ci.id, ci.invoice_number, ci.company_id,
       COALESCE(ci.client_id, ci.customer_id) AS customer_id,
       c.company_id AS customer_company_id, ci.total_amount, ci.status
  FROM customer_invoices ci
  LEFT JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
 WHERE COALESCE(ci.client_id, ci.customer_id) IS NOT NULL
   AND (c.id IS NULL OR c.company_id <> ci.company_id)
UNION ALL
SELECT 'customer_payments', cp.id, cp.payment_number, cp.company_id,
       cp.client_id, c.company_id, cp.total_amount, cp.status
  FROM customer_payments cp
  LEFT JOIN customers c ON c.id = cp.client_id
 WHERE cp.client_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> cp.company_id)
UNION ALL
SELECT 'credit_notes', cn.id, cn.credit_note_number, cn.company_id,
       cn.client_id, c.company_id, cn.total_amount, cn.status
  FROM credit_notes cn
  LEFT JOIN customers c ON c.id = cn.client_id
 WHERE cn.client_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> cn.company_id)
UNION ALL
SELECT 'customer_quotes', q.id, q.quote_number, q.company_id,
       q.client_id, c.company_id, q.total, q.status
  FROM customer_quotes q
  LEFT JOIN customers c ON c.id = q.client_id
 WHERE q.client_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> q.company_id)
UNION ALL
SELECT 'customer_sales_orders', so.id, so.order_number, so.company_id,
       so.customer_id, c.company_id, so.total_amount, so.status
  FROM customer_sales_orders so
  LEFT JOIN customers c ON c.id = so.customer_id
 WHERE so.customer_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> so.company_id)
UNION ALL
SELECT 'recurring_invoices', ri.id, ri.template_name, ri.company_id,
       ri.client_id, c.company_id, ri.total_amount, ri.status
  FROM recurring_invoices ri
  LEFT JOIN customers c ON c.id = ri.client_id
 WHERE ri.client_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> ri.company_id)
UNION ALL
SELECT 'practice_clients', pc.id, pc.legal_name, pc.company_id,
       pc.link_customer_id, c.company_id, NULL, pc.status
  FROM practice_clients pc
  LEFT JOIN customers c ON c.id = pc.link_customer_id
 WHERE pc.link_customer_id IS NOT NULL AND (c.id IS NULL OR c.company_id <> pc.company_id)
 ORDER BY 1, 3;
```

A non-empty result on `customer_invoices` is the one to act on first: those rows are
what the portal PDF renders, so each is a tax invoice carrying another tenant's
identifying details.

Round 3's columns — same shape, one row per mismatch. Production not measured.

```sql
SELECT t.tbl, t.id, t.company_id, t.customer_id, c.company_id AS customer_company_id
  FROM (
    SELECT 'customer_write_offs' AS tbl, id, company_id, client_id AS customer_id FROM customer_write_offs
    UNION ALL SELECT 'delivery_notes', id, company_id, customer_id FROM delivery_notes
    UNION ALL SELECT 'projects', id, company_id, client_id FROM projects
    UNION ALL SELECT 'customer_activities', id, company_id, customer_id FROM customer_activities
    UNION ALL SELECT 'customer_contacts', id, company_id, customer_id FROM customer_contacts
    UNION ALL SELECT 'customer_delivery_addresses', id, company_id, customer_id FROM customer_delivery_addresses
    UNION ALL SELECT 'customer_dunning_overrides', NULL::uuid, company_id, customer_id FROM customer_dunning_overrides
    UNION ALL SELECT 'bank_categorisation_rules', id, company_id, client_id FROM bank_categorisation_rules
    UNION ALL SELECT 'bank_transactions.suggested', id, company_id, suggested_client_id FROM bank_transactions
    UNION ALL SELECT 'time_entries', id, company_id, customer_id FROM time_entries
    UNION ALL SELECT 'archive_customer_invoices', id, company_id, COALESCE(client_id, customer_id)
                FROM archive_customer_invoices
    UNION ALL SELECT 'accounting_adjustments', id, company_id, entity_id
                FROM accounting_adjustments WHERE entity_type = 'customer'
    UNION ALL SELECT 'portal_payment_links', pl.id, ci.company_id, pl.client_id
                FROM portal_payment_links pl JOIN customer_invoices ci ON ci.id = pl.invoice_id
  ) t
  LEFT JOIN customers c ON c.id = t.customer_id
 WHERE t.customer_id IS NOT NULL
   AND (c.id IS NULL OR c.company_id <> t.company_id)
 ORDER BY 1, 3;
```

A `bank_categorisation_rules` hit matters beyond itself: the suggestion pass copies its
`client_id` onto every matching bank line (S16), so correct the rule, not only the lines.
