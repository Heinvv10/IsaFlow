# K-057 — Credit-note PDF references columns that do not exist

**Claim (AA H / A H25).** The query selects a missing column, so every credit-note
PDF request throws.

**Corrected trigger.** Confirmed, and it is TWO missing columns, not one. Fixing only
the first surfaces the second, so both must go in the same change.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)
- `creditNotePdfBuilder.ts:33` — `LEFT JOIN customers c ON c.id =
  COALESCE(cn.client_id, cn.customer_id)`. `credit_notes` has no `customer_id`.
- `creditNotePdfBuilder.ts:36` — `LEFT JOIN users u ON u.id = cn.approved_by::TEXT`
  selecting `u.full_name`. `users` has `first_name` / `last_name`, no `full_name`.
- Executed against the fixture DB (production schema, zero rows):
  `ERROR:  column cn.customer_id does not exist` — the query fails at parse time, so
  the row count is irrelevant and every company is affected unconditionally.
- Column lists from `information_schema.columns`:
  `credit_notes` → `client_id, supplier_id, customer_invoice_id, supplier_invoice_id,
  approved_by, …` (no `customer_id`);
  `users` → `first_name, last_name, email, id, …` (no `full_name`).
- Reachability: `pages/api/accounting/credit-note-pdf.ts:26` →
  `generateCreditNotePdf` re-exported through `invoicePdfService.ts:11`. One route,
  no branch that avoids the query.
- Note `credit_note_items` also does not exist; the builder already tolerates that
  with a try/catch at lines 45-51, so it is not part of this defect.

## RED test
`tests/integration/k057-credit-note-pdf-missing-column.int.test.ts` — 1 test,
**1 failed**: `error: column cn.customer_id does not exist`, raised from the real
service against a real approved credit note. Output: `red.log`.

## Proposed minimal fix
In `creditNotePdfBuilder.ts`: replace `COALESCE(cn.client_id, cn.customer_id)` with
`cn.client_id`, and replace `u.full_name AS approved_by_name` with
`NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS approved_by_name`.
Nothing downstream changes — both values are already consumed as optional strings.

## Historical-data impact
None. This is a read path that has never succeeded; no row was ever written by it.
The impact is operational: customers have not been able to receive a credit-note PDF,
and the failures surface as 500s from `credit-note-pdf`. Confirm the blast radius from
Bugsink rather than the database.

## Risks
Very low. The one thing to check before merging is that no other caller relies on
`approved_by_name` being exactly the `full_name` shape, and that a credit note whose
`approved_by` is NULL still renders — the LEFT JOIN already allows that.
