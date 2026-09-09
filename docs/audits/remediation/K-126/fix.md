# K-126 — invoice PDF prints each line's own VAT rate

**Trigger.** The candidate claim ("every line's VAT prints as zero") is refuted by the schema:
`customer_invoices.tax_rate` defaults to 15.00 and the builder read `Number(inv.tax_rate || 15)`.
The real defect is the mirror image, confirmed in validation.md: `invoicePdfBuilder.ts` applied ONE
header rate to EVERY line and ignored `customer_invoice_items.tax_rate`, which both conversion
paths (quoteConvertService, salesOrderWorkflowService) populate per line. A part zero-rated
invoice printed 15% VAT against the zero-rated line, so the VAT column no longer footed to the
tax_amount in the totals block — an incorrect SARS tax invoice.

**Before / after.** Before: line VAT = line amount x header rate, totals label always `VAT (n%)`.
After: line VAT = line amount x that line's `tax_rate`, falling back to the header rate when the
line carries none; the totals label drops the percentage to plain `VAT` when the lines carry more
than one distinct rate, because `VAT (15%)` is a false statement about a mixed-rate invoice.

**Files.** `src/modules/accounting/services/ar/invoicePdfBuilder.ts` (1 file, no new imports).
The `|| 15` -> `?? 15` on the header rate is defensive only: pg returns `numeric(5,2)` as the
string `'0.00'`, which is truthy, so the two operators are equivalent today. It is pinned by a
characterisation test rather than a red-on-master one.

**Tests.** `tests/integration/k126-invoice-pdf-line-vat-header-rate.int.test.ts` — 5 tests on real
Postgres, driving `generateInvoicePdf` and parsing the emitted content stream. Mixed-rate column
and its footing, mixed-rate totals label, legacy lines with no rate falling back to the header,
a header rate of zero staying zero, and a second tenant refused. Mutation proof: reverting the
production change turns tests 1 and 2 red; reverting only `?? 15` to `|| 15` changes nothing,
which is why that half is documented as defensive.

**Migration.** None. No schema or data change.

**Historical-data impact.** No stored row is wrong: the header `tax_amount` is correct and the GL
is posted from it. The damage is confined to documents already rendered and to sealed snapshots.
Read-only impact query (do not run against production without approval):
```sql
SELECT ci.company_id, ci.id, count(DISTINCT it.tax_rate) AS distinct_rates
FROM customer_invoices ci JOIN customer_invoice_items it ON it.invoice_id = ci.id
GROUP BY ci.company_id, ci.id HAVING count(DISTINCT it.tax_rate) > 1;
```
Those invoices were issued with an overstated per-line VAT column and may need reissue.

**Limits.** `invoicePdfSnapshotService` treats a sealed snapshot as evidence; snapshots sealed
before this fix keep the wrong column and are not rewritten here. Re-sealing is a separate,
deliberate decision. The totals block itself was always correct and is unchanged.

---

## Blind review of ade12166 — LOW-1, LOW-3, LOW-4, LOW-5 (all fixed)

**LOW-1 (fixed).** The "foots to the totals block" assertion compared the column sum to the literal
`15` and never read the totals block, so a change to how the totals VAT renders would have passed.
A `totalsVatOf` helper now parses the rand figure beside the totals VAT label, and the test asserts
the column sum against that parsed value.

**LOW-4 (fixed).** `vatLabelOf` sliced from `lastIndexOf('Subtotal') + 1`, which is `0` when the
token is absent — the scan would then reach the line table's own bare `'VAT'` column header, which
is exactly what the mixed-rate test expects, so that test could pass vacuously after a layout
change. The slice is now `totalsBlockOf`, which throws when there is no totals block.

**LOW-3 (fixed, wider than the commit).** `quotePdfBuilder` printed each line's own
`customer_quote_lines.tax_rate` in the table while hardcoding the literal `'VAT (15%)'` in the
totals block, so a mixed-rate quote contradicted itself on the page — and the quote is the source
document for the invoice this item fixes. It now carries the same `mixedRates` label switch, and
the boilerplate terms sentence no longer asserts 15%. New suite
`tests/integration/k126b-quote-pdf-mixed-vat-rate-label.int.test.ts`, 3 tests; mutation M12
restores the literal and the mixed-rate test goes red.
`creditNotePdfBuilder` was checked and needs no change: `credit_note_items` does not exist in the
schema (the builder catches the error and renders without a line table), so there are no per-line
rates to contradict, and its label reads the header `tax_rate` correctly.

**LOW-5 (fixed).** validation.md's impact SQL grouped by `ci.id` and then counted distinct `ci.id`,
so the column was always 1. Replaced with fix.md's correct form.

**Not a finding, confirmed.** The reviewer accepted the disclosed `?? 15` gap. Unchanged.

---

## Round-2 review of 3d8ad9ba — MEDIUM-3, LOW-6, LOW-7 (all fixed)

**MEDIUM-3 (fixed, both builders).** `mixedRates` fired only when the lines disagreed with EACH
OTHER. When every line carried the same rate and that rate differed from the header's, the label
fell back to the header and stated a rate every line on the page contradicts — a fully zero-rated
export invoice whose header still holds the 15.00 column default is the ordinary shape of it, and
it printed `VAT (15%)`. The invoice half was inherited from ade12166; the quote half was introduced
in 3d8ad9ba. Both now compute `distinctRates` from the lines and label with the single line rate
when there is one, falling back to the header only when there are no lines at all. Mutations M16
and M17 restore the old expression and the new uniform-zero test goes red in each suite.

**LOW-6 (fixed).** The quote line cell moved from `Number(line.tax_rate || 15)` to
`lineRate(line)`, which was neither disclosed nor mutation-covered: pg returns `numeric(5,2)` as a
truthy string, so the two agree on every rate EXCEPT a NULL one, where the old code printed the
literal 15 and the new one prints the quote's own header rate. A fourth quote with a NULL line rate
under a header rate of 20 now pins it; mutation M18 restores the old expression and it goes red.

**LOW-7 (fixed).** `credit_note_items` does not exist, so `SELECT * FROM credit_note_items` raised
42P01 on every call and a bare `catch {}` swallowed it. The builder runs under `withAuth`, which
holds one transaction per request, so the transaction was aborted from that point: any query added
to the route afterwards would fail with 25P02 naming nothing, and the COMMIT would find a dead
transaction. The query is now gated on `to_regclass('public.credit_note_items') IS NOT NULL`, which
answers the same question without raising. Mutation M19 restores the try/catch and the transaction
test goes red.

**Discovered while proving LOW-7: the credit-note PDF endpoint was returning 500 for every credit
note.** Two columns named in the builder's main query do not exist. `credit_notes` has no
`customer_id` — the repo's `COALESCE(client_id, customer_id)` rule is about `customer_invoices` and
was applied here by pattern — and `users` has no `full_name`, only `first_name`/`last_name`. Both
raise 42703 before any of the above is reached, so the whole endpoint threw. Fixed to `cn.client_id`
and to `NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '')`. This is outside the five
findings and was not asked for, but LOW-7 could not be proven without it and the file was already
being changed. Mutation M20 restores the COALESCE and all three tests go red.

**Tests.** New `tests/integration/k126c-credit-note-pdf-transaction-safety.int.test.ts`, 3 tests:
the builder runs inside a real BEGIN on an AsyncLocalStorage client, a following query succeeds and
the COMMIT holds; the PDF renders its totals block without a line-items table; another tenant's
credit note is refused. `k126` grows to 6 tests and `k126b` to 5.

**Historical-data impact.** No stored row changes. Any credit-note PDF that previously 500'd now
renders. Invoice and quote PDFs whose lines uniformly disagree with the header stop claiming the
header's rate; the impact query already in this file finds the mixed-rate invoices, and this
variant finds the uniform ones:
```sql
SELECT ci.company_id, ci.id, MIN(it.tax_rate) AS line_rate, ci.tax_rate AS header_rate
FROM customer_invoices ci JOIN customer_invoice_items it ON it.invoice_id = ci.id
GROUP BY ci.company_id, ci.id, ci.tax_rate
HAVING count(DISTINCT it.tax_rate) = 1 AND MIN(it.tax_rate) <> ci.tax_rate;
```
