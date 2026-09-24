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
  - A zod body schema, using the shared `UUID` (`z.guid()`; Zod 4's `.uuid()` rejects seeded ids). A schema failure is a 400 naming the field.
  - A `WipInvoiceRefusal` is a 400 with its message.
  - Everything else is re-thrown to `withErrorHandler`: a 500 that `withAuth` rolls back.
- **`respondIfLockTimeout`** now includes `WipEntriesLockedError` (503 + Retry-After, message intact).
- **Page:** `assertOk` + `apiErrorMessage`.

## Evidence
All runs are against the fixture `isaflow-fixture-r112`.
- `tests/integration/r120-wip-invoice-refusal.int.test.ts`: 10 tests, driven through `withAuth`, with NODE_ENV=test so masking applies.
  - **RED** on master (`red.log`, 8 tests at the time): 7 failed. Two of the failures were bookings (201): taxRate 101 and the embedded negative line.
  - **GREEN:** 10 of 10.
- `tests/unit/services/practice/wipInvoiceGuards.test.ts`: 9 of 9.
- `tests/unit/components/WipInvoiceRefusalMessage.test.tsx`: red on master's page, green on the fix.
- **Existing WIP suites:** k-040 ×2 and k107, integration, pass. So do the practice unit tests, 18 files and 226 tests.
- **Mutations** (`mutations.log`): 10, all red. Two survived the first round (M4, M6), and the reason for each is in the log.

## Historical-data impact
None from the masking. The two booking defects may have left rows. Hand this to Hein; it is read-only and has **not** been run on production:
```sql
-- WIP invoices with a tax rate over 100, or carrying a negative line
SELECT ci.company_id, ci.invoice_number, ci.tax_rate, ci.total_amount
FROM customer_invoices ci
WHERE ci.tax_rate > 100
   OR EXISTS (SELECT 1 FROM customer_invoice_items i
              WHERE i.invoice_id = ci.id AND i.time_entry_id IS NOT NULL AND (i.amount < 0 OR i.unit_price < 0));
```

## Not covered
- `createTimeEntry` still accepts a negative rate (R-119 note). This fix refuses it at billing, not at capture.
- The `by_work_item` and `by_category` grouping paths sum lines that `assertWipEntryLines` has already vetted.
