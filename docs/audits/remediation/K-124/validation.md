# K-124 — dispute credit-note creation ignores the legacy customer_id

Baseline: origin/master `31fc2f1062d228f6ebf43049338ecb41767002d0`.

**Claim.** Creation and four joins use client_id only, so legacy-linked disputes resolve against nothing.

**Corrected trigger.** Confirmed as written, and the schema makes it worse than the claim implies:
`customer_invoices.customer_id` is NOT NULL while `client_id` is NULLABLE, so the legacy column is
the reliable one. CLAUDE.md mandates `COALESCE(ci.client_id, ci.customer_id)`; a partial index
`idx_ci_coalesce_client` exists for exactly that expression. `resolveDispute` reads bare
`client_id` and the four `listDisputes` branches join `customers` on `ci.client_id`.

**Disposition: confirmed.**

**Evidence.**
- `git show origin/master:src/modules/accounting/services/ar/disputeService.ts` :290-300 (credit path),
  :199/:211/:222/:233 (joins).
- `\d customer_invoices` on the schema fixture: `customer_id uuid NOT NULL`, `client_id uuid` nullable.
- Contrast: `dunningService.loadInvoiceCtx` (:140) already joins on `COALESCE(ci.client_id, ci.customer_id)`.
- RED: `tests/integration/k124-dispute-credit-legacy-customer-id.int.test.ts` — 2 failed.
  `clientName` is null in the list; `resolveDispute` throws
  `Cannot auto-create credit note: invoice has no client` at disputeService.ts:299.

**Reachability.** `raiseDispute` (:116-124) never inspects `client_id`, so a dispute can be raised on
such an invoice — including from the customer portal (`pages/api/portal/invoice/[token]/dispute.ts`).
Once raised it can never be resolved with credit.

**Proposed minimal fix (1 file).**
In `resolveDispute`, select `COALESCE(client_id, customer_id) AS client_id`; in the four
`listDisputes` branches, change `LEFT JOIN customers c ON c.id = ci.client_id` to
`ON c.id = COALESCE(ci.client_id, ci.customer_id)` and select the coalesced value. No migration.

**Historical-data impact.** Stuck-open disputes on legacy invoices. Read-only:
```sql
SELECT d.company_id, count(*) AS stuck
FROM customer_invoice_disputes d
JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
WHERE d.status = 'open' AND ci.client_id IS NULL
GROUP BY d.company_id;
```
No wrong rows were written — the write was refused — so the fix unblocks rather than corrects.

**Risks.** Widening the join could attach a customer name to invoices whose two columns disagree.
Worth a one-off read-only check for `client_id IS NOT NULL AND client_id <> customer_id` before shipping.
