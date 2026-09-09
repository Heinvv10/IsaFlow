# K-040 — Overlapping WIP runs bill the same time twice

**Claim (A C6 + B F12, critical):** Eligible time entries are read without a lock and the
`markEntriesBilled` count is never checked, so two invoices are returned successfully.

**Corrected trigger:** Both named mechanisms are present and the double-bill is reachable, but
not by the simplest reading. `withAuth` does supply an outer READ COMMITTED transaction, and
two *fully* overlapping runs in one company collide on `uq_customer_invoices_company_number`
before either can double-bill. The defect bites in the wider window: when the competing run
commits its billing between this run's eligibility read and its invoice-number read, the
numbers no longer collide and nothing else stops the second invoice.

## Disposition: confirmed

## Evidence (`git show ebeac9ca:<path>`; file unchanged since 5661d6f0)
- `practiceWipService.ts:155-171` — eligibility SELECT filters `status='approved' AND
  billed_at IS NULL` with no `FOR UPDATE`, so the rows it returns are not held.
- `practiceWipService.ts:260-273` — `await markEntriesBilled(...)` in a bare statement. The
  return value is discarded; only a thrown error is handled.
- `practiceTimeEntryWorkflow.ts:204-224` — `markEntriesBilled` re-applies
  `status='approved' AND billed_at IS NULL` in the UPDATE and returns `rows.length`. It is the
  only writer of `billed_at` in the codebase, and returning 0 is its way of reporting a loss.
- `src/lib/auth/withAuth.ts:100` — plain `BEGIN`, i.e. READ COMMITTED. Confirms the plan's
  correction: there *is* an outer transaction.
- `uq_customer_invoices_company_number UNIQUE (company_id, invoice_number)` exists on
  `customer_invoices`. A first attempt at this test, with two full concurrent runs, failed on
  that index instead: the loser's caught unique violation left its transaction aborted and the
  next statement raised 25P02. That accidental guard is why the naive reproduction does not
  show a double-bill, and it is not a guard anyone designed.
- Secondary observation, not the claim: the retry-on-collision loop at
  `practiceWipService.ts:184-215` is dead code inside a transaction — the caught error has
  already poisoned it, so `continue` cannot succeed. Worth its own item.

## Reachability
`POST /api/accounting/practice/wip/invoice`
(`pages/api/accounting/practice/wip/invoice.ts:33`,
`withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))))`). Any write-access user.
Note the route catches and answers `badRequestFromError` — a 4xx — so a guard that merely
throws will be committed rather than rolled back by `withAuth`; the fix must not rely on the
handler's own catch.

## RED test
`tests/integration/k-040-wip-overlapping-runs-double-bill.int.test.ts` — real Postgres, three
pool clients, deterministic (run B is parked on an uncommitted duplicate key and released only
after run A commits; no timing assumptions). Log shows
`Marked time entries billed count:0` followed by `Generated WIP invoice ... INV-00001`, and the
assertion fails `expected 2 to be 1` on the number of invoice lines citing the entry.
Output in `red.log`.

## Proposed minimal fix
1. `practiceWipService.ts:155` — append `FOR UPDATE OF te` to the eligibility SELECT so the
   competing run blocks rather than proceeding on a stale read.
2. `practiceWipService.ts:262` — capture the count:
   `const marked = await markEntriesBilled(companyId, eligibleIds, invoiceId);`
   and `if (marked !== eligibleIds.length) throw new Error('time entries were billed
   concurrently — invoice not generated');`
3. Because the route turns a throw into a 400, which `withAuth` commits, either widen the
   guard to a 5xx or wrap steps 3-5 in a savepoint that this check rolls back. Step 2 alone is
   not sufficient.

## Historical-data impact
Any entry appearing on more than one invoice line is a realised double-bill. Read-only:
```sql
SELECT ci.company_id, cii.time_entry_id, count(*) AS invoice_lines,
       array_agg(DISTINCT ci.invoice_number) AS invoices
FROM customer_invoice_items cii
JOIN customer_invoices ci ON ci.id = cii.invoice_id
WHERE cii.time_entry_id IS NOT NULL
GROUP BY 1,2 HAVING count(*) > 1;
```
A companion check for the orphan case (invoice line exists, entry never marked):
```sql
SELECT ci.company_id, ci.invoice_number, cii.time_entry_id
FROM customer_invoice_items cii
JOIN customer_invoices ci ON ci.id = cii.invoice_id
JOIN time_entries te ON te.id = cii.time_entry_id
WHERE te.invoice_id IS DISTINCT FROM ci.id;
```
Both are cheap and safe to run on production. Practice WIP billing is low-volume, so the
realised count is likely small, but each hit is a customer over-charged.

## Risks
`FOR UPDATE` on the eligibility read holds entry rows for the length of the invoice build,
which includes a per-entry INSERT loop. On a large WIP selection that lengthens the lock
window; pair it with a `lock_timeout` as `bankTxLock.ts` does rather than letting a second run
wait indefinitely.
