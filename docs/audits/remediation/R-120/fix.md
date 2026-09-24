# R-120: a refused WIP invoice told the operator nothing

## Defects
The entry was registered as a masking defect with no data risk. The red run found more.
1. **Masked reason.** `pages/api/accounting/practice/wip/invoice.ts` answered every error with `badRequestFromError(…, 'WIP invoice failed')`, which drops the message outside development. The refusals affected: no linked AR customer, nothing eligible, concurrent billing, and lock contention. A lock timeout, whose own error says "retry", was a 400 as well.
2. **Page read the wrong field.** `pages/accounting/practice/wip/index.tsx` read `json.error` as a string. The envelope is `{ error: { code, message } }`, so an unmasked message would have shown as "[object Object]".
3. **A tax rate over 100 booked.** The route validated nothing. `taxRate: 101` returned 201, with VAT larger than the subtotal. A negative rate reached migration 692's trigger as a raw error.
4. **A negative entry inside a positive selection booked.** `time_entries` CHECKs `hours > 0`, but nothing constrains `rate` or `line_total`. A small negative entry billed alongside a normal one produced a positive invoice carrying a negative line: a credit embedded in a sale. A check on the sum passes it.
5. **A malformed id** in `timeEntryIds` reached Postgres as 22P02.

## Fix
- **`wipInvoiceGuards.ts`:** `WipInvoiceRefusal`, `assertWipTaxRate` (0–100, finite, default 15) and `assertWipEntryLines` (per line: rate and line finite and ≥ 0). `generateWipInvoice` throws `WipInvoiceRefusal` for every refusal the operator can act on. The guards run before anything is written.
- **Route:**
  - A zod body schema, using the shared `UUID` (`z.guid()`; Zod 4's `.uuid()` rejects seeded ids) and `z.iso.date()` for a real calendar date. `taxRate: null` still means the default 15. A schema failure is a 400 naming the field. A string `taxRate` ("15") is now refused; the page always sends a number.
  - A `WipInvoiceRefusal` is a 400 with its message.
  - Everything else is re-thrown to `withErrorHandler`: a 500 that `withAuth` rolls back.
- **`respondIfLockTimeout`** now includes `WipEntriesLockedError` (503 + Retry-After, message intact).
- **Page:** `assertOk` + `apiErrorMessage`.

## Evidence
All runs are against the fixture `isaflow-fixture-r112`.
- `tests/integration/r120-wip-invoice-refusal.int.test.ts`: 18 tests, driven through `withAuth`, with NODE_ENV=test so masking applies.
  - **RED** on master (`red.log`, 8 tests at the time): 7 failed. Two of the failures were bookings (201): taxRate 101 and the embedded negative line.
  - **GREEN:** 18 of 18.
- `tests/unit/services/practice/wipInvoiceGuards.test.ts`: 12 of 12. The component test has 2 cases.
- `tests/unit/components/WipInvoiceRefusalMessage.test.tsx`: red on master's page, green on the fix.
- **Existing WIP suites:** k-040 ×2 and k107, integration, pass. So do the practice unit tests, 18 files and 226 tests.
- **Mutations** (`mutations.log`): 19, all red. M4 was retired as redundant, and the reason is in the table above. Two survived the first round (M4, M6), and the reason for each is in the log.

## Review round 1
| Finding | Fix | Proof |
|---|---|---|
| MEDIUM (general): nothing tested that a fault is a 500 and rolls back. Masking every fault back into a 400 kept all 10 tests green. | Test: an entry whose line overflows the invoice's `numeric(15,2)` (22003) returns 500, commits no invoice, and leaves the entry approved. | M11 goes red. |
| MEDIUM (general): the census missed grouped invoices, whose lines carry `time_entry_id` NULL. | The census joins through `time_entries.invoice_id`. | Validated against the fixture schema (EXPLAIN). |
| LOW: a NULL `applied_rate` passed as 0. | A NULL rate or line is refused. | Unit cases added; M12 goes red. |
| LOW: an impossible date reached Postgres as 22008 (now a 500). | `z.iso.date()`. | Test added; M13 goes red. |
| LOW: `taxRate: null` became a 400. | `.nullish()` maps it to the default. | Test added; M14 goes red. |
| LOW: the inactive-client refusal was untested. | Test added. | M15 goes red. |
| LOW: a stale savepoint comment, and backlog `historicalDataImpact` contradicting fix.md. | Both corrected. | — |
| adv. REPRO1: a 3-decimal taxRate booked VAT that the stored `numeric(5,2)` rate does not explain. | `assertWipTaxRate` refuses more than 2 decimals. | Unit test and integration test; M17 goes red. |
| adv. REPRO3: a `line_total` that disagrees with hours × rate billed the stored figure (R5000 for 2h @ R100). | `assertWipEntryLines` refuses a line more than 1c from `round2(hours × applied_rate)`. Every writer stores it that way (`lineTotalFor`). The explicit `line < 0` test is dropped as redundant: hours > 0 is a CHECK, so the line is negative only when the rate is. | Unit test and integration test; M18 goes red. |
| adv. REPRO5: a partly ineligible selection billed the remainder silently. | Not refused: K-040 deliberately bills what a peer did not take, and pins it in a test. The result now carries `skippedEntryCount`, and the page's toast says how many entries were left out. | Integration test and component test; M19 and M20 go red. |
| adv. REPRO6: a legacy cross-tenant `link_customer_id` billed another company's customer (no FK). | Step 1 joins `customers` on `company_id` and `deleted_at IS NULL`. No live own-company customer is a refusal. | Integration test; M16 goes red. |
| adv. REPRO7: the census missed grouped invoices. | Same fix as the general reviewer's MEDIUM (join through the entries). | — |

## Historical-data impact
None from the masking. The two booking defects may have left rows. Hand this to Hein; it is read-only and has **not** been run on production:
```sql
-- WIP invoices with a tax rate over 100, or billing a negative/NULL-rate time
-- entry. Joined through the BILLED ENTRIES, not the invoice lines: in the
-- by_work_item / by_category modes a negative entry is folded into a group
-- line with time_entry_id NULL, and its sign may be hidden by the sum.
SELECT ci.company_id, ci.invoice_number, ci.tax_rate, ci.total_amount
FROM customer_invoices ci
WHERE ci.tax_rate > 100
   OR EXISTS (SELECT 1 FROM time_entries te
              WHERE te.invoice_id = ci.id AND te.company_id = ci.company_id
                AND (te.line_total < 0 OR te.applied_rate < 0 OR te.applied_rate IS NULL));
```

## Not covered
- `createTimeEntry` still accepts a negative rate (R-119 note). This fix refuses it at billing, not at capture.
- The `by_work_item` and `by_category` grouping paths sum lines that `assertWipEntryLines` has already vetted.
