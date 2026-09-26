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
  - both customers `FOR NO KEY UPDATE`, in id order;
  - the source's bank lines, then its receipts, then its invoices, each set `ORDER BY id` (the canonical order in `bank/.claude.md`).
- The customers are locked `NO KEY UPDATE`, not `UPDATE`. A bank allocation locks the line first and then inserts a receipt naming the customer, and that FK takes `FOR KEY SHARE` on the customer row. `FOR UPDATE` blocks `KEY SHARE`, so a merge waiting on that line would deadlock the allocation (40P01 → 500). A reviewer caught this and the lock-order test reproduced it. `NO KEY UPDATE` still conflicts with itself, so two merges still queue.
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
| portal_access | client_id | **DEACTIVATE** the source's logins; never move them (Hein). The table has no `company_id` and no RLS, so it is scoped through the customer |
| bank_categorisation_rules | client_id | MOVE. Otherwise a rule would keep allocating to a deleted customer |
| bank_transactions | suggested_client_id | MOVE (a suggestion only) |
| practice_clients | link_customer_id | MOVE |
| entity_udf_values | entity_id (entity_type 'customer') | MOVE fields the target lacks. Where both have set a field, the target's value stands and the source's is deleted |
| customers (source) | — | soft-delete, ` [MERGED]`, keeps `external_ref`/Sage history (Hein) |
| customers.opening_balance | — | SKIP. It is set at creation and read by no statement, aging or ledger. The figure the books opened with lives in the journals |
| gl_journal_lines / gl_journal_entries | — | none: no customer column. Journals follow their source documents |
| audit_log | entity_id | SKIP: history stays as written |
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
- `pages/accounting/customers/dedup.tsx`
- `src/lib/apiRoutes.ts`

**Tests.** There are 25 tests across five files: `tests/integration/k061-customer-merge-{moves,refusals,sage-resync,lock-order}.int.test.ts` and `k061-duplicates-merge-customer.int.test.ts`.
- **Lock-order, same set:** for each of the bank-line, receipt and invoice sets, a settlement holds the lower id and then takes the higher one while a merge is blocked. Neither side may deadlock.
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
UNION ALL SELECT 'customer_contacts', count(*) FROM customer_contacts x JOIN customers c ON c.id = x.customer_id WHERE c.deleted_at IS NOT NULL;

-- 2b. Invoices generated for a deleted customer AFTER it was deleted (a duplicates-page merge leaving recurring billing on).
SELECT ci.company_id, c.name, count(*) AS invoices, sum(ci.total_amount) AS total
FROM customer_invoices ci JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
WHERE c.deleted_at IS NOT NULL AND ci.created_at > c.deleted_at AND ci.deleted_at IS NULL
GROUP BY 1, 2 ORDER BY 3 DESC;

-- 3. How often the new dunning refusal would bite: companies whose customers have overrides.
SELECT company_id, count(*) FROM customer_dunning_overrides GROUP BY 1 ORDER BY 2 DESC;
```

**Residuals.**
- A document created for the source by another request while a merge is running, and committed after it, stays on the now-deleted source. Invoice and receipt creation do not lock the customer row. The merge does lock both customers, so a second merge cannot interleave.
- `src/components/accounting/customers/MergeCustomersModal.tsx` also calls this route and reads `json.message`, so it would show a generic error on a refusal. Nothing imports it; it is left alone as unrelated dead code.
- The source's conflicting custom-field values are deleted, not archived.
- `softDeleteRowOps.restoreRow('customer')` can un-delete a merged-away source. It comes back empty, with ` [MERGED]` in its name and its portal logins off.
- Four mutants survive, and all four are equivalent (mutations.log explains each). Three drop a company-scope predicate that `app_user` RLS already enforces. One drops the customers' `ORDER BY id`, and this merge is the only path that locks two customer rows.
