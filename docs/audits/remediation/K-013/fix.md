# K-013 — fix

**Trigger.** `generateInvoiceFromRecurring` INSERTed a `customer_invoices` header at
`status='approved'` directly, wrote no `customer_invoice_items`, posted no journal, and then
advanced the schedule. Every recurring run left a receivable in AR with `gl_journal_entry_id`
NULL and no detail behind it. The schedule UPDATE was also keyed on `id` alone.

**Before.** approved header, 0 line items, 0 journals, schedule advanced regardless.
**After.** header inserted at `'draft'`, one `customer_invoice_items` row per template line, then
`approveCustomerInvoice` — the canonical path that runs the status CAS, posts DR AR / CR Revenue /
CR VAT Output and seals the PDF. The schedule advances only after that returns, and its UPDATE now
carries `AND company_id`. A template with zero lines is refused before anything is written.
Header + lines + approve run inside one `withSavepoint('recurring_invoice_gen')`, because the batch
runner (`recurring-invoices-run.ts:89`) catches per template and carries on inside the shared
request transaction: without it a failed template's half-built invoice would be COMMITted on the
route's 200, and the caught Postgres error would poison every later item with 25P02.

**Files.** `src/modules/accounting/services/ar/recurringInvoiceService.ts` (only production file).

**Tests.** `tests/integration/k013-recurring-invoice-no-lines-no-gl.int.test.ts` — 4 tests, real
Postgres (disposable fixture DB), all passing. Covers: lines written and journal posted, journal
balanced with the receivable leg equal to the invoice total (1150) and revenue/VAT legs at
1000/150, schedule advanced once; empty template refused with the schedule untouched; another
tenant cannot run the template; a failure at approval rolls the header and its lines back inside a
real request transaction that stays usable. Mutation-proof: see `green.log` (M1/M2/M3).

**Migration.** None. **Rollback.** Revert the commit; no schema or data change.

**Historical-data impact.** Existing invoices minted by past recurring runs are still in AR with no
journal and no lines. Read-only probe:
```sql
SELECT ci.company_id, count(*) AS invoices, sum(ci.total_amount) AS receivable
FROM customer_invoices ci
WHERE ci.gl_journal_entry_id IS NULL
  AND ci.status IN ('approved','sent','partially_paid','paid')
  AND NOT EXISTS (SELECT 1 FROM customer_invoice_items i WHERE i.invoice_id = ci.id)
GROUP BY 1 ORDER BY 3 DESC;
```
Back-posting those journals is a separate exercise: it must use each invoice's own date and period,
and VAT output landing in closed VAT periods needs a decision before any write.

**Limits.** Not fixed here: the batch runner still reports per-template failures only in an
`errors[]` array on a 200 response. Routing through the canonical path means a run now fails when
the fiscal period is closed or a system account is unmapped, where it previously "succeeded"
silently — that is the intended behaviour change and callers will start seeing those errors.

---

# Review round (blind review of 1ef8c82e — 1 HIGH, 3 MEDIUM, 3 LOW)

All seven addressed. Evidence in `green-review.log`.

**H1 — a repeat run posted a duplicate journal.** `generateInvoiceFromRecurring` now takes
`FOR UPDATE` on the template row through `recurringInvoiceLock.ts` (5s `lock_timeout`, typed
`RecurringInvoiceLockTimeoutError`, same shape as bankTxLock), refuses without a request
transaction rather than holding a lock that releases immediately, and refuses a template whose
`next_run_date` is in the future with `RecurringInvoiceNotDueError`. A template that is genuinely
overdue still mints the next owed period per call — that is the schedule catching up, not a
duplicate. **Behaviour change:** the "Run Now" button on a not-yet-due template is now refused; the
error names the remedy (move the next run date forward). No force flag was added, since nothing
calls one.

**M1 — schedule UPDATE outside the savepoint.** Moved inside. The runner and the action route now
call `assertTxUsable()` in their catch blocks, so a failure that poisoned the shared transaction
rethrows into a 500 instead of a 200/4xx that withAuth commits while handing back invoice ids that
will not survive.

**M2 — module doc stated the opposite contract.** `src/modules/accounting/services/ar/.claude.md`
corrected (the stale `generateDueInvoices` name too) and `bun run agent-docs:generate` run.

**M3 — lines never reconciled with the header.** Header subtotal/tax/total are now DERIVED from the
parsed lines, so sum(items) + VAT = total = the receivable debit by construction, and the stored
aggregate is checked against them (`assertAggregateAgrees`, tolerance one cent per line for
accumulated rounding) so a drifted template is refused rather than silently re-priced.

**L1 — unvalidated JSON cast.** `parseLineItems` validates every element and raises a named
`RecurringInvoiceTemplateError`: unreadable JSON, empty template, blank description, non-positive or
non-numeric quantity, missing/negative unit price. `Number(null)` is 0, so a null unit price is
rejected explicitly rather than billed at zero.

**L2 — fixed savepoint name.** Now sequenced, `recurring_invoice_gen_${n}`, per neon.ts's convention.

**L3 — noted, no action.** Restated in `green-review.log`.

**New files.** `recurringInvoiceLock.ts` (68), `recurringInvoiceTemplate.ts` (114) — split out to
keep `recurringInvoiceService.ts` at 278 lines, under the 300 limit.

**Tests.** `tests/integration/k013-...int.test.ts` 12 tests (was 4) and
`tests/unit/services/recurringInvoiceTemplate.test.ts` 14 tests, all passing. Six new mutations
recorded (N1-N6).

**Historical-data impact — unchanged from above, plus two more populations to inspect** (read-only,
never run here):
```sql
-- templates whose stored totals no longer match their lines: these will now be
-- refused at run time until re-saved.
SELECT company_id, id, template_name, total_amount
FROM recurring_invoices WHERE status = 'active';  -- compare against line_items by hand
-- templates with an unusable line: blank description, quantity <= 0, or no unitPrice.
SELECT company_id, id, template_name
FROM recurring_invoices ri
WHERE status = 'active' AND EXISTS (
  SELECT 1 FROM jsonb_array_elements(ri.line_items) li
  WHERE COALESCE(TRIM(li->>'description'), '') = ''
     OR COALESCE((li->>'quantity')::numeric, 0) <= 0
     OR li->>'unitPrice' IS NULL);
```
