# K-124 — disputes follow the legacy customer_id when client_id is NULL

**Trigger.** `customer_invoices.customer_id` is NOT NULL while `client_id` is nullable, and CLAUDE.md
mandates `COALESCE(ci.client_id, ci.customer_id)`. `resolveDispute` selected bare `client_id` and the
four `listDisputes` branches joined `customers` on `ci.client_id` only. On a migrated invoice
(`client_id` NULL) the dispute listed with a blank customer name and could never be resolved with
credit — `resolveDispute` threw "Cannot auto-create credit note: invoice has no client".

**Before.** `clientName` null; resolve_with_credit throws; the dispute stays open forever.
**After.** All four list branches select and join on `COALESCE(ci.client_id, ci.customer_id)`, and
`resolveDispute` reads the same expression. `client_id` still wins when both columns are populated,
so nothing changes for modern invoices. The partial index `idx_ci_coalesce_client` already covers the
expression.

**Files.** `src/modules/accounting/services/ar/disputeService.ts` (4 list branches + resolve path).

**Tests.** `tests/integration/k124-dispute-credit-legacy-customer-id.int.test.ts` — 5 passed (real DB):
legacy dispute lists with its customer name; resolves with a credit note; `client_id` still preferred
when both columns are set (credit note booked against the client, not the legacy customer); the credit
note is booked against the legacy customer for the disputed amount; another tenant sees nothing.
Mutation check: dropping the 8 COALESCE sites → 3 failed.

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** No wrong row was written — the write was refused — so the fix unblocks
rather than corrects. Stuck-open disputes, read-only (NOT run against production):
```sql
SELECT d.company_id, count(*) AS stuck
FROM customer_invoice_disputes d
JOIN customer_invoices ci ON ci.id = d.customer_invoice_id
WHERE d.status = 'open' AND ci.client_id IS NULL
GROUP BY d.company_id;
```

**Limits.** The validation asked for a one-off check that no invoice has
`client_id IS NOT NULL AND client_id <> customer_id`; that is a production query, so it was not run.
The disagreement case is covered behaviourally instead: COALESCE prefers `client_id`, asserted by the
third test. `disputeService.ts` was already 398 lines (over the 300-line cap) before this change and
is now 415; splitting it is out of scope here.

## Round 2 (blind review M6)
Widening the population via `COALESCE(client_id, customer_id)` made a dormant defect reachable:
`resolveDispute` called `createCreditNote` with `taxRate: 0` and the VAT-INCLUSIVE disputed amount,
booking the whole amount to revenue and nothing to VAT output. The rate is now derived from the
invoice (`tax_amount / subtotal`) and the disputed amount split back out. Existing zero-VAT credit
notes are identified by the read-only SQL in `../K-122/fix.md` and left for an accountant.

## Round 3 (blind review M-3, L-3)
`resolveDispute` was check-then-act: it read `status = 'open'` and then updated on `id` alone, so two
concurrent resolves both created a credit note for the same disputed amount and the second UPDATE
orphaned the first. It now claims the dispute with one status-predicated UPDATE BEFORE any document is
created, and links `credit_note_id` afterwards. The VAT split also passes an exact `taxAmount`
(`gross − subtotal`) so `subtotal + tax` equals the disputed amount to the cent. The dead `ci.client_id`
select and its `LEFT JOIN customer_invoices` are gone.
`tests/integration/k124b-dispute-resolve-concurrency.int.test.ts` — 4 passed (real DB): two concurrent
resolves produce exactly one credit note and the dispute points at it; a closed dispute is refused with
nothing written; another tenant gets "not found" and the row stays open; 10.00 at 15% splits to
8.70 + 1.30 = 10.00.
