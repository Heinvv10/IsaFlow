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

### Reserved, not fixed here

**R-068** — the supplier twin. `ap/supplierInvoiceService.ts:144` writes
`input.supplierId` from the request body into `supplier_invoices.supplier_id`; the
one company-scoped read above it (`:134`) fetches `vat_number` for the duplicate
fingerprint and a miss yields `NULL`, not a refusal. `pages/api/accounting/purchase-orders.ts:42`
does the same with `body.supplierId`. `supplierBelongsToCompany` exists and, again,
only the MCP tools call it. Out of scope here per the brief.

**R-068 also owns `bankAllocationService.ts:246-249`** — the supplier arm of
`allocateTransaction`, identical in shape to the customer arm fixed above:
`entityId` from the request body, a name lookup that falls back to
`` `Supplier #${entityId}` ``, and a `supplier_payments` document created against
this company for another tenant's creditor. The MCP callers are covered
(`checkLinesOwnership` → `suppliersBelongToCompany`); the HTTP routes are not. One
line, `assertSupplierInCompany`-shaped, in the same place — registered rather than
taken here because the supplier twin is R-068's scope.

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
| `tests/unit/services/customerOwnershipFence.test.ts` (19) | per call site, **by outcome**: a foreign id is refused and the ownership SELECT is the *only* statement that ran (no INSERT/UPDATE/DELETE); an own-tenant id gets past the fence into the rest of the path |
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
