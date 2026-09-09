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

**Files.**
- `src/modules/accounting/services/practice/wipEntryLock.ts` (new) — `lockEligibleWipEntries`,
  `WipEntriesLockedError`. Mirrors `bank/bankTxLock.ts`, including the note on why `SET LOCAL`
  is re-issued per call rather than memoised.
- `src/modules/accounting/services/practice/practiceWipService.ts` — step 2 delegates to the
  lock helper; steps 3-5 wrapped in `withSavepoint('wip_invoice_build')`; billed-count guard.
- `src/modules/accounting/services/practice/.claude.md` (+ AGENTS.md mirror).

**Tests.** `tests/integration/k-040-wip-overlapping-runs-double-bill.int.test.ts` — 4 passed,
real Postgres, pool clients, deterministic (`pg_stat_activity` polling, no sleeps): overlapping
runs bill the entry once and the invoice foots to its lines; a second tenant is neither blocked
nor billed; an empty selection writes no invoice; an unreleasable lock refuses the run.
`tests/unit/services/practice/practiceWipService.test.ts` — 8 passed, adds the
outside-a-transaction refusal and the short-count guard. Full unit suite 9393 passed.
Mutation-proofed both production changes; see `green.log`, including the honest note that
without the lock the losing run dies on `uq_customer_invoices_company_number` in this ordering.

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

**Limits.** The invoice-number retry loop (`practiceWipService.ts`, step 3) is still dead code
inside a transaction: a caught unique violation has already poisoned it, so `continue` cannot
succeed. Untouched — it is the validator's separate secondary observation, and it now aborts
the whole savepoint rather than half a write. A partially overlapping selection still bills the
entries it did win and silently drops the ones a peer took, which is the pre-existing behaviour
for any ineligible id in the selection.
