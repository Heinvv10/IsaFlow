# BL-29 — supplier_invoices total_amount field naming — CLOSED (not a bug today)

**Audit finding F-014:** GET `/api/accounting/supplier-invoices?limit=3` returns both `totalAmount` and `total_amount: null`.

## Verification (2026-04-14)

Live response from master post-BL-24 (commit `547a647` onward):
```
source /tmp/isaflow-admin-token.env
curl -H "Cookie: isaflow_auth=$TOKEN" -H "X-Company-Id: 00000000-0000-0000-0000-000000000001" \
  "http://localhost:3200/api/accounting/supplier-invoices?limit=1" | jq '.data.invoices[0]'
```
The response object's total/amount keys are: `['amountPaid', 'subtotal', 'taxAmount', 'totalAmount']` — camelCase only.

## Mapper inspection

`src/modules/accounting/services/ap/supplierInvoiceService.ts:265-300` (`mapInvoiceRow`) returns a fully enumerated object with no `...row` spread. No snake_case leak possible.

## Verdict

- **Close BL-29 without code changes.**
- The audit finding was either stale (pre-BL-24 which reduced `SELECT si.*` to explicit columns) or captured from a different endpoint.
- No follow-up required.
