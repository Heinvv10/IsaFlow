# K-040 fix — overlapping WIP runs bill the same time entry twice

**Trigger.** `POST /api/accounting/practice/wip/invoice`. `generateWipInvoice` read the
approved, unbilled entries of a selection with no row lock, then invoiced them. Under
`withAuth`'s READ COMMITTED transaction a competing run that committed its billing after this
run's eligibility read left the entry already billed: `markEntriesBilled` matched nothing, its
`0` was discarded, and the same hours went out on a second invoice.

**Before.** Two runs, one entry, two invoice lines, no error. **After.** The eligibility read
takes `FOR UPDATE OF te` under a 5s `lock_timeout`. The second run blocks there; when the first
commits, READ COMMITTED re-checks the predicate against the new row version, `billed_at` is
set, the entry leaves the selection and the run refuses with "no eligible approved time entries
in selection" before writing anything. A lock it cannot take within 5s surfaces as
`WipEntriesLockedError` ("retry in a moment") rather than a wait that pins the connection.
The invoice build now also runs in a savepoint and asserts `markEntriesBilled` marked every
selected entry; the route answers a caught error with a 400, which `withAuth` COMMITs, so
without the savepoint that guard would leave the orphan invoice it meant to prevent.

The invoice-number retry loop now takes a savepoint per attempt. A peer's number arrives as
a 23505 that aborts the transaction, so before this the caught error made `continue` unable to
run one further statement: the five attempts never happened and the caller got a raw
"current transaction is aborted" as a 400. It retries for real now, and it retries contiguously:
the number is `MAX + 1`, never `MAX + 1 + attempt`. The re-read after a rollback already sees
the peer's committed number, so the old offset skipped one and gapped the VAT invoice sequence
(a collision on INV-00001 produced INV-00003).

**Files.**
- `src/modules/accounting/services/practice/wipEntryLock.ts` (new) — `lockEligibleWipEntries`,
  `WipEntriesLockedError`. Mirrors `bank/bankTxLock.ts`, including the note on why `SET LOCAL`
  is re-issued per call rather than memoised. `40P01` (deadlock, which `lock_timeout` does not
  bound) maps to the same retryable error as `55P03`; both `LEFT JOIN`s carry `company_id`.
- `src/modules/accounting/services/practice/practiceWipService.ts` — step 2 delegates to the
  lock helper; steps 3-5 wrapped in `withSavepoint('wip_invoice_build')`; billed-count guard.
  290 -> 246 lines.
- `src/modules/accounting/services/practice/wipInvoiceNumber.ts` (new) — `insertWipInvoice`:
  the header INSERT, its savepoint per attempt and the contiguous number retry, lifted out of
  the service so the 300-line module limit is not the next change's problem.
- `scripts/simulate-fy2026-workflows.ts` — the one non-route caller. It had no transaction, so
  every WIP invoice it attempted would now be refused; it supplies its own `als.run` client.
- `src/modules/accounting/services/practice/.claude.md` (+ AGENTS.md mirror).

**Tests.** `tests/integration/k-040-wip-overlapping-runs-double-bill.int.test.ts` — 6 passed,
real Postgres, pool clients, deterministic (`pg_stat_activity` polling, no sleeps): overlapping
runs bill the entry once and the invoice foots to its lines; a partly overlapping selection
bills only the entries the peer did not take, on its own invoice number; a competing run in the
same company retries its invoice number instead of dying; a second tenant is neither blocked nor
billed; an empty selection writes no invoice; an unreleasable lock refuses the run.
`tests/integration/k-040-wip-billed-count-rollback.int.test.ts` — 1 passed, stubs
`markEntriesBilled` short and proves the savepoint removes the invoice it had written while the
transaction stays usable. `tests/unit/services/practice/practiceWipService.test.ts` — 9 passed.
`tests/unit/services/practice/wipInvoiceNumber.test.ts` — 5 passed: the number is `MAX + 1`,
stays contiguous across one and two collisions, gives up after five, and does not retry a
non-23505 error. Full unit suite 9399 passed. Five production changes mutation-proofed; see
`green.log`,
including the honest note that with only the lock removed the losing run dies on
`uq_customer_invoices_company_number` in that ordering.

**Migration.** None. **Rollback.** Revert the commit; no schema or data change.

**Historical data.** Entries already double-billed are not corrected. Read-only, safe on
production:
```sql
SELECT ci.company_id, cii.time_entry_id, count(*) AS invoice_lines,
       array_agg(DISTINCT ci.invoice_number) AS invoices
FROM customer_invoice_items cii
JOIN customer_invoices ci ON ci.id = cii.invoice_id
WHERE cii.time_entry_id IS NOT NULL
GROUP BY 1,2 HAVING count(*) > 1;
```
Each hit is a customer over-charged and needs a credit note; practice WIP billing is
low-volume, so the count is likely small. Not run here — no production query was issued.

**Limits.** The 5s `lock_timeout` is transaction-scoped, so it also bounds the later waits in
the same request: a peer holding an uncommitted duplicate invoice number for more than 5s now
fails this run with a bare "canceling statement due to lock timeout" rather than parking it.
Deliberate, and the trade `bankTxLock.ts` already makes, but it is a new failure mode the
helper's error mapping does not reach. A partially overlapping selection bills the entries it
won and silently drops the ones a peer took — the pre-existing behaviour for any ineligible id
in the selection, now covered by a test. The `40P01` mapping and the `company_id` join
predicates are reasoned, not mutation-tested: a real deadlock is plan-dependent, and the
foreign keys already make the join predicates redundant in practice.
