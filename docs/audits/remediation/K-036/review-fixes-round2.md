# Follow-up review remediation — K-035 / K-036 (review of 7179f208)

Seven findings: N1–N4 MEDIUM, N5–N7 LOW. All fixed. N4 is a deploy step, not code.

**N1 — the fee was never posted when the portal verify route won the race.** Two
short-circuits stood in front of it, not one. `recordGatewayInvoiceReceipt` returned on its
`bank_reference` dedupe before reaching the fee, and above that `handleChargeSuccess` returned
even earlier: its guarded `UPDATE … AND status <> 'completed'` matches nothing once verify has
completed the request, so the webhook never called the service at all. Both are fixed. The fee
posting moved to `gatewayFeeService.ts` with its own idempotency (a lookup for an existing
`Paystack fee <reference>` entry) and now runs on the dedupe path; `handleChargeSuccess`
re-reads an already-completed request and still records the receipt, which posts only what is
missing. The wrong comment in `verify.ts` is corrected.

**N2 — a non-UUID author was attributed to another tenant's user.** `resolveUserUuid` falls
back to `SELECT id FROM users … LIMIT 1` with no company filter and no ORDER BY. Replaced with
a company-scoped `resolveCompanyActor`: the invoice's author if that author is a UUID and a
member of the paying company, else that company's default member (deterministic —
`is_default`, then `created_at`, then `user_id`), else it throws. Failing closed is right here:
a receipt stamped with a stranger's name is worse than a retryable 500, and K-035 makes the
redelivery reprocess once a member exists.

**N3 — the over-allocation guard came back.** The clamp now subtracts allocations pending on
draft payments, the same query `createCustomerPayment` used, so a draft receipt claiming the
balance no longer lets both confirm past `total_amount`. The gateway cash is still banked in
full; it simply allocates nothing.

**N5** — the index predicate is `status IS DISTINCT FROM 'cancelled'`, so a NULL status cannot
slip past it. Migration 620 dropped and re-applied on the fixture DB to prove it.
**N6** — deploy timing noted in the migration header: no `CONCURRENTLY` inside the runner's
transaction, so it takes a SHARE lock on `customer_payments`; run out of hours.
**N7** — an unparseable `paid_at` falls back to today with a warning instead of reaching
`fmtDate` as an Invalid Date and raising 22007 on every redelivery. The closed-period case
stays as designed: a delivery that only succeeds after the settlement month is closed needs a
manual replay.

**N4 — deploy step, needs production access.** Run this BEFORE migration 620. A single hit
makes `CREATE UNIQUE INDEX` fail and stops the deploy at this migration.

```sql
SELECT company_id, bank_reference, count(*) AS duplicates
FROM customer_payments
WHERE payment_method = 'card'
  AND bank_reference IS NOT NULL
  AND status IS DISTINCT FROM 'cancelled'
GROUP BY company_id, bank_reference
HAVING count(*) > 1;
```

Expected: zero rows. `isaflow_dev` returns zero across 57 card payments. Production has NOT
been queried. On a hit, cancel or merge the duplicate receipts before deploying.

**Structure.** The fee leg moved to `src/modules/accounting/services/ar/gatewayFeeService.ts`
so both files stay inside the 300-line limit (receipt 240, fee 89).

**Tests.** 6 new real-DB cases in the K-036 suite: fee booked when verify wins, fee not booked
twice on redelivery, actor scoped to the paying company, delivery fails rather than attributing
to nobody, draft receipt leaves no room, unparseable `paid_at`. Reverting the three source files
to 7179f208 turns 5 of the 6 red (the sixth, fee-not-twice, passes there because the old path
posted a fee at all only in the webhook-alone case). Totals: K-035 6, K-036 19,
public-route-tx 4 — 29 passed.
