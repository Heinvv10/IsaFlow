# K-013 — recurring run mints an approved invoice with no lines and no GL journal

**Claim (audit A H17 / B F28):** the run inserts an approved header only, omitting line items and
ledger posting, then advances the schedule.

**Disposition: confirmed** (as stated).

**Mechanism.** `generateInvoiceFromRecurring`
(`git show ebeac9ca:src/modules/accounting/services/ar/recurringInvoiceService.ts`) INSERTs
straight into `customer_invoices` with `'approved'` hard-coded in the VALUES list (lines 131-143).
It never calls `approveCustomerInvoice`, writes nothing to `customer_invoice_items` even though the
template carries `line_items`, and posts no journal. It then advances `last_run_date`,
`next_run_date` and `run_count` unconditionally (:145-150) — and that UPDATE is keyed on `id` alone,
with no `company_id` predicate, against the repo's multi-tenant rule.

The canonical path is explicit about why this matters: `approveCustomerInvoice`
(`customerInvoiceApprovalService.ts:133-142`) posts DR AR / CR Revenue / CR VAT Output on approve
and refuses to swallow a failure, because an approved invoice sitting in AR with
`gl_journal_entry_id` NULL means "AR and the GL disagreed by the invoice total with nothing
surfacing the divergence". The recurring generator produces exactly that row.

**Reachability.** `POST /api/accounting/recurring-invoices-run` (single and batch, lines 50 and 89)
and `POST /api/accounting/recurring-invoices-action` (line 40). Every recurring run since the
feature shipped. File unchanged between 5661d6f0 and ebeac9ca.

**Evidence.** RED test `tests/integration/k013-recurring-invoice-no-lines-no-gl.int.test.ts`
(1 test / 1 failed, three soft assertions failing — `docs/audits/remediation/K-013/red.log`) against
a R1 000 + R150 VAT monthly template:
- `customer_invoice_items` count `expected +0 to be 1`;
- `customer_invoices.gl_journal_entry_id` `expected null not to be null`;
- posted `gl_journal_entries` count `expected +0 to be 1`.
The header itself is created correctly at `status='approved'` with `total_amount = 1150.00`, so the
receivable exists with no revenue, no VAT output and no invoice detail behind it.

**Proposed minimal fix** (`recurringInvoiceService.ts:131-150`):
- Insert the header at `'draft'`, then insert one `customer_invoice_items` row per entry in
  `ri.line_items` (description, quantity, unit_price, amount, tax_rate).
- Call `approveCustomerInvoice(companyId, invoiceId, userId)` so the GL posting, the status CAS and
  the PDF seal all run on the one canonical path.
- Advance the schedule only after that returns, and add `AND company_id = ${companyId}` to the
  `recurring_invoices` UPDATE.

**Historical-data impact.** Every invoice a recurring run produced is in AR with no GL entry and no
lines. This is a direct contributor to the known AR-subledger-vs-account-1120 divergence.
Read-only probe:
```sql
SELECT ci.company_id, count(*) AS invoices, sum(ci.total_amount) AS receivable
FROM customer_invoices ci
WHERE ci.gl_journal_entry_id IS NULL
  AND ci.status IN ('approved','sent','partially_paid','paid')
  AND NOT EXISTS (SELECT 1 FROM customer_invoice_items i WHERE i.invoice_id = ci.id)
GROUP BY 1 ORDER BY 3 DESC;
```
Remediation of existing rows is a separate exercise: back-posting the missing journals must use the
invoice's own date and period, and VAT output for closed VAT periods needs a decision before any
write.

**Risks.** Routing through `approveCustomerInvoice` makes a run fail when the target fiscal period
is closed or a system account is unmapped, where today it silently "succeeds". That is the correct
behaviour, but the batch runner at `recurring-invoices-run.ts:89` must report per-template failures
rather than aborting the whole batch.
