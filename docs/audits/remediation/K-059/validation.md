# K-059 — dunning chases invoices that are not debts

**Claim.** `dunningCronService.ts:114` selects overdue invoices with no status or
soft-delete filter, so customers are chased for documents that are not debts.

**Corrected trigger.** There *is* a status filter — `ci.status NOT IN ('cancelled','paid')`
(`git show origin/master:src/modules/accounting/services/ar/dunningCronService.ts`, line 115).
It is the wrong shape: `customer_invoices_status_check` allows `draft` and
`pending_approval`, and the table carries `deleted_at`, which the query never
mentions. So a draft, an unapproved invoice and a soft-deleted invoice are all
selected and emailed. The correct filter is an allow-list of issued statuses
plus `ci.deleted_at IS NULL`, not a deny-list.

**Disposition: confirmed.**

**Evidence.**
- Source unchanged between the audited `5661d6f0` and `origin/master`
  (`git log --oneline 5661d6f0..origin/master -- <path>` is empty).
- Schema: `customer_invoices` has `deleted_at timestamptz`; status check allows
  `draft`, `pending_approval` (fixture DB `isaflow_schema_fixture`).
- Reachable: `pages/api/cron/dunning-send.ts:37` calls `runDunningCron`.
- RED test: `tests/integration/k059-dunning-chases-non-debts.int.test.ts`.
  Four invoices (draft / pending_approval / soft-deleted / sent); `sendDunning`
  is stubbed and records invoice ids. Expected `[sent]`, got all four.
  1 test, 1 failed. Output: `red.log`.

**Proposed minimal fix.** In the `overdue_invoices` CTE (line 115) replace the
deny-list with `ci.status IN ('sent','overdue','partially_paid','approved')`
and add `AND ci.deleted_at IS NULL`. No other file changes; the ladder,
cool-off and dispute gates are unaffected.

**Historical-data impact.** Every `dunning_sends` row whose invoice was draft,
pending_approval or soft-deleted at send time is an email a customer should
never have received (POPIA / reputational, not ledger). Read-only count:

```sql
SELECT ds.id, ds.customer_invoice_id, ds.sent_at, ci.status, ci.deleted_at
FROM dunning_sends ds JOIN customer_invoices ci ON ci.id = ds.customer_invoice_id
WHERE ci.deleted_at IS NOT NULL OR ci.status IN ('draft','pending_approval');
```
Not run — production is out of scope for this validation.

**Risks.** An allow-list must include every issued status a company actually
uses; confirm `approved` belongs before shipping, or overdue approved invoices
stop being chased.
