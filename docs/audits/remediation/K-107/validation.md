# K-107 — Recurring invoice numbers are constant for a month

**Claim.** The generated number is a name slug plus YYYYMM, so a daily or weekly template collides on its second run.

**Disposition: confirmed.**

**Corrected trigger.** `src/modules/accounting/services/core/recurringTransactionService.ts:166-169` builds `RINV-${slug}-${YYYYMM}` and `:199-202` builds `RSINV-${slug}-${YYYYMM}`; both derive the period from `new Date().toISOString().slice(0,7)`, constant for the calendar month. The two entity types then fail differently:
- Customer invoices: `uq_customer_invoices_company_number` (`scripts/migrations/sql/220_multi_company_scoping.sql:158`) rejects the second run with SQLSTATE 23505, so a daily or weekly AR template succeeds on day one and 500s every day after.
- Supplier invoices: no such unique index exists, and `idx_supplier_invoices_duplicate_fp` (`412_supplier_coding_rules.sql:65-67`) is a plain index, not unique. A daily AP template creates one identical bill per day with the same number and the same `duplicate_fingerprint`.

**Evidence.** Files above via `git show origin/master:<path>`; constraint presence and absence verified against the fixture schema.

**RED test.** `tests/integration/k107-recurring-invoice-number-collision.int.test.ts` — 2 failed of 2. AR: observed `{second: '23505', distinct: 1}` against `{second: 'ok', distinct: 2}`. AP: observed `distinctNumbers: 1` for 2 rows. Log: `red.log`.

**Reachability.** `executeRecurring` is reachable from the recurring-transactions API for any active template with frequency `daily` or `weekly`.

**Proposed minimal fix (3-6 lines).** Replace the month token with a per-company sequence, or append the run date and an ordinal: build the candidate as `RINV-${slug}-${YYYYMMDD}` and, on the AR side, resolve collisions through the existing document-numbering service rather than a hand-built string. Add `uq_supplier_invoices_company_number` so the AP side fails loudly rather than duplicating.

**Historical-data impact.** Any tenant with a daily or weekly `supplier_invoice` template has duplicate bills that inflate accounts payable and input VAT. Read-only impact SQL (not run against production):
```sql
SELECT company_id, invoice_number, count(*), sum(total_amount)
FROM supplier_invoices
WHERE invoice_number LIKE 'RSINV-%'
GROUP BY 1,2 HAVING count(*) > 1;
```
Monthly and quarterly templates are unaffected.

**Risks.** Adding the AP unique index will fail if duplicates already exist; clean them first.
