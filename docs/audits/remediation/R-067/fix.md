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
| 23 | `ar/gatewayInvoiceReceiptService.ts:157`, `bank/bankAllocationService.ts:425` | derived from an invoice/transaction already read company-scoped | **exempt** — no caller-supplied id |

### Reserved, not fixed here

**R-068** — the supplier twin. `ap/supplierInvoiceService.ts:144` writes
`input.supplierId` from the request body into `supplier_invoices.supplier_id`; the
one company-scoped read above it (`:134`) fetches `vat_number` for the duplicate
fingerprint and a miss yields `NULL`, not a refusal. `pages/api/accounting/purchase-orders.ts:42`
does the same with `body.supplierId`. `supplierBelongsToCompany` exists and, again,
only the MCP tools call it. Out of scope here per the brief.

### Noted, not fixed (pre-existing, unrelated to this finding)

`quoteService.ts:87` — `nextQuoteNumber()` reads
`SELECT quote_number FROM customer_quotes ORDER BY created_at DESC LIMIT 1` with
**no `company_id` filter**. RLS keeps it honest for `app_user`, but the query is
wrong on its face and would number quotes from another tenant's sequence on any
path that runs as a superuser.

## Tests

| File | What it pins |
|---|---|
| `tests/unit/services/assertCustomerInCompany.test.ts` (7) | the fence itself: owned passes, foreign refuses, absent id issues **no query**, the read is company-scoped + `deleted_at IS NULL`, savepoint name ≤31 chars, 22P02 → refusal, any other error propagates |
| `tests/unit/services/customerOwnershipFence.test.ts` (16) | per call site, **by outcome**: a foreign id is refused and the ownership SELECT is the *only* statement that ran (no INSERT/UPDATE/DELETE); an own-tenant id gets past the fence into the rest of the path |
| `tests/integration/customer-ownership-fence.int.test.ts` (3) | against a real database, because the hole *is* the schema: company B's customer is refused and `customer_invoices` is left empty; company A's own customer still creates the invoice with both columns set; a non-UUID is refused and the connection stays usable |

Two existing suites (`customerInvoiceCreateRetry`, `customerPaymentService`) now stub
`assertCustomerInCompany` — they pin behaviour *after* the fence and their `sql`
mock queues would otherwise shift by one call.

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
