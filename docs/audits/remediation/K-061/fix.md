# K-061 — fix

**Trigger.** Step 3 of `customer-merge.ts` ran `UPDATE customer_payments SET customer_id = ...`. That table has `client_id` and no `customer_id`, so Postgres raised 42703, `withTransaction` rolled the merge back, and the handler answered 500. No merge has ever succeeded.

**Before / after.** Validation warned that fixing step 3 alone would wake up a half-merge, because the other steps moved only some of a customer's rows. So the merge was rebuilt against a census of every table that stores a customer id, rather than patched line by line.
- The logic lives in `src/modules/accounting/services/ar/customerMergeService.ts`. The route now only validates the two ids and maps an `ArRequestError` (the AR module's only 4xx) to a 400.
- **Two routes merged customers, and now both use this service.** The census found a second path: `POST /api/accounting/duplicates-merge` (the `/accounting/duplicates` page), through `core/duplicateMergeService.mergeCustomers`. That path worked, but:
  - it moved five tables only (payments, invoices, credit notes, sales orders, quotes);
  - it left the duplicate's contacts, addresses, activities, write-offs, projects, delivery notes, dunning override, bank rules, archived invoices, time entries and portal logins on a deleted customer;
  - its **active recurring invoices kept billing** that deleted customer;
  - it set `client_id` on every invoice it touched, including an invoice whose `client_id` named a third customer;
  - it took no lock, and a cross-tenant id answered 500.

  Its customer branch now calls this service, with primary as target and duplicate as source. Its route also refuses a non-UUID id with a 400.
- Every step runs in one transaction. As a savepoint inside withAuth's request transaction, it is all-or-nothing.
- Every refusal comes before the first write:
  - an id that is not a UUID (it used to 500 on the cast);
  - a merge into itself;
  - either customer not live in this company, including another tenant's;
  - both customers holding a dunning override.
- Locks, in this order, before any write:
  - the source's bank lines, then its receipts, then its invoices, each set `ORDER BY id` (the canonical order in `bank/.claude.md`);
  - then the source's `recurring_invoices` and `recurring_transaction_templates`, each set `ORDER BY id`, so a recurring run already in progress commits first and its invoice is moved;
  - then both customers `FOR NO KEY UPDATE`, in id order, followed by the refusal checks.
- **Why settlement rows come first:** a bank allocation or refund takes the bank line and THEN the customer. That is either `lockContactForRefund`'s `FOR UPDATE`, or the FK `KEY SHARE` of the receipt it inserts. A merge that took the customers first was the inverse order and deadlocked both shapes (40P01 → 500). Review caught it, and both shapes were reproduced RED in `k061-customer-merge-lock-order`.
- **Why `NO KEY UPDATE`:** it does not wait on an FK `KEY SHARE`, and it still conflicts with itself, so two merges queue.
- **Run all due.** `recurring-invoices-run` holds every template it has run until the request ends, and it walked them by `next_run_date`. Two templates of one customer whose due-date order and id order disagree were therefore locked in the inverse order to a merge (40P01; review round 3). It still chooses the batch by due date, but it now processes that batch in id order. `k061-recurring-run-lock-order.int.test.ts` pins this through the real route.
- **Fail closed on contention (review round 4).** Every review round found another multi-step path that can interleave with a merge, whatever order the merge takes its own locks in. The latest was `writeBankBulkAllocate`, which locks line B1 → the customer's invoices → line B2 in one transaction. Rather than chase each one:
  - the merge bounds its waits (`SET LOCAL lock_timeout = '5s'`);
  - a 55P03 or 40P01 becomes `ArRequestError(409, 'CUSTOMER_MERGE_CONTENDED')`, which both routes answer as 409 "retry in a moment";
  - this is safe because the merge runs in a savepoint that rolled back, and nothing was written before it;
  - `k061-customer-merge-contention` pins a held invoice (409, census digest unchanged, then the retry succeeds) and the bulk interleave (never a 500).
- Consequence: an override created for the target between the dunning check and the move makes that move raise 23505. That is a 500, and the savepoint rolls the whole merge back.
- Two merges of the same pair in opposite directions therefore queue. The second re-reads `deleted_at`, finds its customer gone, and gets a 400. Before the fix, both such merges 500'd.
- The source is soft-deleted:
  - `deleted_at` is now set, where before only `is_active = false` was;
  - its name gets ` [MERGED]`;
  - it cannot be merged again.
- `/accounting/customers/dedup` now calls the route through `apiJson`, so a refusal shows the server's message. Before, it read `body.message`, which the envelope never carries, and showed `HTTP 400`. The success toast states how many recurring invoices were paused.

**Census.** Sources: `information_schema` and `pg_constraint` on `isaflow_schema_fixture`, plus `git grep` across migrations and services for `customer_id`, `client_id`, `entity_id`, `linked_entity_id`, `counterparty_id` and `link_customer_id`.

| Table | Column | Decision |
|---|---|---|
| customer_invoices | customer_id, client_id | MOVE each column independently; a NULL `client_id` stays NULL, so `COALESCE(client_id, customer_id)` names the target |
| archive_customer_invoices | customer_id, client_id | MOVE (same rule) |
| customer_payments | client_id | MOVE |
| credit_notes | client_id | MOVE |
| customer_write_offs | client_id | MOVE |
| customer_quotes | client_id | MOVE |
| customer_sales_orders | customer_id | MOVE |
| delivery_notes | customer_id | MOVE |
| projects | client_id | MOVE |
| time_entries | customer_id | MOVE |
| payment_transactions | customer_id | MOVE |
| accounting_adjustments | entity_id (entity_type 'customer') | MOVE |
| portal_payment_links | client_id | MOVE. The table has no `company_id`, so it is scoped through its invoice |
| customer_contacts | customer_id | MOVE. A moved primary is demoted when the target already has one |
| customer_delivery_addresses | customer_id | MOVE. A moved default is demoted when the target already has one |
| customer_activities | customer_id | MOVE |
| customer_dunning_overrides | customer_id (PK with company) | MOVE when only the source has one. **REFUSE when both do** (Hein) |
| recurring_invoices | client_id | MOVE and **pause** the source's active templates; they are counted in the response (Hein) |
| recurring_transaction_templates | `template_data->>'clientId'` (entity_type 'customer_invoice', JSON) | MOVE (`jsonb_set`) and **pause** (`is_active = false`), counted with the above. The runner (`recurringTransactionInvoices`) reads the id from the JSON, so an unmoved template would keep invoicing the merged-away customer. Review caught it: the first census searched columns, not JSON |
| portal_access | client_id | **DEACTIVATE** the source's logins; never move them (Hein). The table has no `company_id` and no RLS, so it is scoped through the customer |
| bank_categorisation_rules | client_id | MOVE. Otherwise a rule would keep allocating to a deleted customer |
| bank_transactions | suggested_client_id | MOVE (a suggestion only) |
| practice_clients | link_customer_id | MOVE |
| entity_udf_values | entity_id (entity_type 'customer') | MOVE fields the target lacks. Where both have set a field, the target's value stands and the source's is deleted |
| customers (source) | — | soft-delete, ` [MERGED]`, keeps `external_ref`/Sage history (Hein) |
| customers.opening_balance | — | SKIP. It is set at creation and read by no statement, aging or ledger. The figure the books opened with lives in the journals |
| gl_journal_lines / gl_journal_entries | — | none: no customer column. Journals follow their source documents |
| audit_log | entity_id | SKIP: history stays as written |
| custom_report_templates.filters, share_links.params, other JSON columns | — | SKIP. Every jsonb/array column was listed. Report filters match on customer NAME (text), and no other JSON holds a customer id a code path reads |
| sage_customer_invoices | customer_name | SKIP: staging matches by name (see Sage below) |
| document_links, procurement_documents, loans | linked_entity_id / entity_id / counterparty_id | SKIP: no code path links them to a customer |
| customer_invoice_* children (disputes, views, dunning_sends, paystack/stitch requests) | customer_invoice_id | none: they follow their invoice |

A new table that stores a customer id must be added to the service AND to `MOVED` in `tests/integration/k061-customer-merge.helpers.ts`. The moves test then asserts that the source has zero rows in it.

**Sage re-sync (Hein, 2026-09-26: accept and document).** All three customer importers match customers by name. After a merge the source is renamed and deleted, so a Sage re-sync creates the old name again as a new, empty customer. The invoices it offers again are refused, because a live invoice with that Sage id already belongs to another customer, so no debt is booked twice. `k061-customer-merge-sage-resync.int.test.ts` proves both. Changing the importers is a separate item.

**Files.**
- `src/modules/accounting/services/ar/customerMergeService.ts` (new)
- `src/modules/accounting/services/core/duplicateMergeService.ts` (customer branch delegates; old private `mergeCustomers` removed)
- `pages/api/accounting/customer-merge.ts`
- `pages/api/accounting/duplicates-merge.ts`
- `pages/api/accounting/recurring-invoices-run.ts` (processes the due batch in id order)
- `pages/accounting/duplicates.tsx` (shows the paused count)
- `pages/accounting/customers/dedup.tsx`
- `src/lib/apiRoutes.ts`

**Tests.** There are 34 tests across seven files: `tests/integration/k061-customer-merge-{moves,refusals,sage-resync,lock-order}.int.test.ts`, `k061-duplicates-merge-customer.int.test.ts` `k061-recurring-run-lock-order.int.test.ts` and `k061-customer-merge-contention.int.test.ts`.
- **Lock-order, same set:** for each of the bank-line, receipt and invoice sets, a settlement holds the lower id and then takes the higher one while a merge is blocked. Neither side may deadlock.
- **Lock-order, recurring run:** for each of `recurring_invoices` and `recurring_transaction_templates`, a run holds its template, the merge waits on it, and the run inserts an invoice for the source. That invoice must end up on the target.
- **Lock-order, unrelated allocation:** an allocation on a line the merge does not lock receipts to the source and then applies to its invoice. This pins `FOR NO KEY UPDATE`.
- **Upper-case template id:** a template whose JSON spells the source id in upper case still moves.
- **Lock-order, refund:** a refund holds the bank line, then locks the customer `FOR UPDATE`.
- **Lock-order, allocator:** one case replays the bank allocator's own lock sequence: line `FOR UPDATE`, then `INSERT` of a receipt naming the source. It runs those statements directly rather than calling `allocateTransaction`, because the lock cycle depends only on those two statements.
- **Split columns:** an invoice whose two columns name different customers moves only the column that names the source.

**Browser acceptance (dev, 2026-09-26, `isaflow_dev`, Brightsphere, reporting-qa user, `next dev` from this branch).**
- Setup: two customers sharing an email were seeded, "K061 Acceptance Traders" (R2 300 invoice) and "… Duplicate" (R1 150 invoice, an active recurring template and a primary contact).
- `/accounting/customers/dedup` then did the following:
  - Scan paired them (`acceptance-1-pair.png`).
  - Merge → Confirm Merge (`acceptance-2-confirm.png`).
  - Merge Now → 200 `{movedDocuments:1, pausedRecurring:1, revokedPortalLogins:0}`, and the toast read "… merged into "K061 Acceptance Traders". 1 recurring invoice paused — review before re-activating." (`acceptance-3-merged.png`).
- The survivor's Activity tab lists both invoices (`acceptance-4-survivor-activity.png`), and its Contacts tab shows the moved contact (`acceptance-5-survivor-contacts.png`).
- In the DB, both invoices name the survivor on both columns, the template is `paused`, and the source is `… [MERGED]` with `deleted_at` set.
- The seeded rows were deleted afterwards.

**Migration / rollback.** None. Rollback is reverting the PR.

**Historical-data impact.**
- `customer-merge`: none. Every attempted merge rolled back whole.
- `duplicates-merge`: **possibly real.** Every customer merged through the duplicates page before this fix left the rows listed above on a deleted customer. Its active recurring invoices may still be generating invoices. The fix does not repair those rows. Correcting them is Hein's call, sized by query 2 below.

The census SQL below confirms the first point and sizes the second. It is read-only; run it on prod yourself; the agent never ran it.

```sql
-- 1. No merge ever landed (expect 0).
SELECT count(*) FROM customers WHERE name LIKE '% [MERGED]';

-- 2. Rows that already point at a soft-deleted customer (strandings from other deletes, not merges).
SELECT 'customer_invoices' t, count(*) FROM customer_invoices ci JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id) WHERE c.deleted_at IS NOT NULL AND ci.deleted_at IS NULL
UNION ALL SELECT 'customer_payments', count(*) FROM customer_payments p JOIN customers c ON c.id = p.client_id WHERE c.deleted_at IS NOT NULL
UNION ALL SELECT 'credit_notes', count(*) FROM credit_notes n JOIN customers c ON c.id = n.client_id WHERE c.deleted_at IS NOT NULL
UNION ALL SELECT 'recurring_invoices (active)', count(*) FROM recurring_invoices r JOIN customers c ON c.id = r.client_id WHERE c.deleted_at IS NOT NULL AND r.status = 'active'
UNION ALL SELECT 'portal_access (active)', count(*) FROM portal_access p JOIN customers c ON c.id = p.client_id WHERE c.deleted_at IS NOT NULL AND p.is_active
UNION ALL SELECT 'customer_contacts', count(*) FROM customer_contacts x JOIN customers c ON c.id = x.customer_id WHERE c.deleted_at IS NOT NULL
UNION ALL SELECT 'recurring_transaction_templates (active)', count(*) FROM recurring_transaction_templates r JOIN customers c ON c.id::text = lower(r.template_data->>'clientId') WHERE r.entity_type = 'customer_invoice' AND c.deleted_at IS NOT NULL AND r.is_active;

-- 2b. Invoices generated for a deleted customer AFTER it was deleted (a duplicates-page merge leaving recurring billing on).
SELECT ci.company_id, c.name, count(*) AS invoices, sum(ci.total_amount) AS total
FROM customer_invoices ci JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
WHERE c.deleted_at IS NOT NULL AND ci.created_at > c.deleted_at AND ci.deleted_at IS NULL
GROUP BY 1, 2 ORDER BY 3 DESC;

-- 3. How often the new dunning refusal would bite: companies whose customers have overrides.
SELECT company_id, count(*) FROM customer_dunning_overrides GROUP BY 1 ORDER BY 2 DESC;
```

**Residuals.**
- A document that another request inserts for the source can end up on the now-deleted source. This happens when the insert commits after the merge's UPDATE for that table has run, and the insert is not held back by any row the merge locks. Invoice and receipt creation do not lock the customer row.
  - The merge closes the two paths that did hold such a lock. Running recurring invoices and recurring templates are locked before any UPDATE, so a run the merge waits for commits first and its invoice is moved (review round 2). An allocation on a line the merge locks also commits first.
  - What remains is an unrelated create racing the merge. The merge does lock both customers, so a second merge cannot interleave.
- `src/components/accounting/customers/MergeCustomersModal.tsx` also calls this route and reads `json.message`, so it would show a generic error on a refusal. Nothing imports it; it is left alone as unrelated dead code.
- The source's conflicting custom-field values are deleted, not archived.
- `recurringTransactionInvoices` (via `assertCustomerInCompany`) does not refuse a soft-deleted customer. A merge now moves and pauses its templates. A customer deleted any other way keeps an active template running, and that is a separate item.
- The duplicates page (`duplicates.tsx`) still reads its response with a hand-written `res.json()` cast, not `apiJson`. It now shows the paused count.
- `softDeleteRowOps.restoreRow('customer')` can un-delete a merged-away source. It comes back empty, with ` [MERGED]` in its name and its portal logins off.
- Four mutants survive, and all four are equivalent (mutations.log explains each). Three drop a company-scope predicate that `app_user` RLS already enforces. One drops the customers' `ORDER BY id`, and this merge is the only path that locks two customer rows.
