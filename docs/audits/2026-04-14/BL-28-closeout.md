# BL-28 — Customer Payments allocatedAmount — CLOSED (not a code bug)

**Audit finding F-013:** GET `/api/accounting/customer-payments` returns `allocatedAmount: 0` for all payments sampled.

## Diagnosis (2026-04-14)

Direct DB query against dev (ISAFlow Demo `00000000-0000-0000-0000-000000000001`):

| Status | Payments | Allocations |
|---|---:|---:|
| confirmed | 366 | 341 |
| draft | 13 | 13 |
| cancelled | 5 | 5 |

93% (341/366) of confirmed payments ARE allocated. The audit's sample of 10 recent payments happened to include the 25 confirmed-but-unallocated rows — a data-quality artifact, not a code bug.

## Service query (`src/modules/accounting/services/ar/customerPaymentService.ts:39, 50, 61`)

```sql
COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount
```

Uses the correct column names (`payment_id`, `amount_allocated`) and is semantically correct.

## Verdict

- **Close BL-28 without code changes.**
- Surface the 25 unallocated confirmed payments via a dashboard alert or reconciliation screen (separate UX feature, not this sprint).
- If Brightsphere's payment allocations were also missing (8,114 bank tx / 132 CI but 0 journal entries per F-010), that's a data import gap owned by BL-19 (deferred).
