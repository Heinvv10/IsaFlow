# K-031 — the VAT201 you see, save and file now comes from the ledger

**Trigger.** `generateVAT201` reads `customer_invoices`, `supplier_invoices` and `supplier_invoice_items` only — never `credit_notes` or manual VAT journals. The route (GET on-screen, POST saved draft) and `submitVAT201ToSars` used it; the export and the MCP VAT tools already used the journal-derived `getVat201Report`. A period with credit notes showed, persisted and would file a return higher than the books.

**Before/after.** R10 000 + R1 500 invoice and an approved R1 000 + R150 credit note, June 2026. Before: field5 R1 500, field1 R10 000. After: field5 R1 350, field1 R9 000.

**Which basis answers which field.** No single basis answers the whole form, so the adapter says which is which instead of zeroing what one cannot see.
- **Ledger** (`getVat201Report`) — 1, 4, 5, 6, 7, 9, 10, 11. Field 1 is every *taxed* output box (1, 1A, 12, unclassified), so tax in field 5 always has a supply value behind it. Field 7 is the remainder after 6, 8 and 9, so the four input fields sum to field 10.
- **Documents** (`getNilRatedSupplies`, new) — 2, 3. A zero-rated or exempt supply posts no VAT control leg, so `vatBoxBasisQuery` never selects its journal and the ledger basis reports R0 turnover for it. Invoices less customer credit notes, by VAT code.
- **Documents** (`generateVAT201`) — 8, plus the drill-down invoice lists. Input tax on services is `supplier_invoice_items.vat_classification`; journal `vat_type` has no goods/services split.

**Two new filing gates.** `evaluateVat201Filability` refuses a return that fails SARS's own 15% tie-out (a journal mixing a taxed and a nil-rated line puts the untaxed base on field 1, because `deriveVatBoxes` apportions base pro-rata by tax) or that declares a negative supply value (a credit-note-only period). `draftDrift` refuses to file figures that differ from the draft a human reviewed, the hazard `exportVat201` guards with its period lock. Both write an audited `blocked` event; neither is reachable while the ISV channel is dark.

**Files.** New `vat201LedgerFields.ts` (`getLedgerVAT201`, `evaluateVat201Filability`) and `vat201NilRatedSupplies.ts`. `pages/api/accounting/sars/sars-vat201.ts` (GET+POST) and `sarsEfilingSubmissionService.ts` (+`draftDrift`) call them; `sarsEfilingRepo.ts` now selects `form_data`. `generateVAT201` is untouched — `vatExceptionsService` needs the invoice population to reconcile against the GL VAT control movement, and `rateCheck` is stripped before the SARS payload.

**Tests.** `tests/integration/k-031-efiling-vat201-source.int.test.ts` — 9 passed on the real schema: ledger agreement, R20 000 zero-rated and R5 000 exempt reported rather than zeroed, the input split footing to field 10 with field 8 from the line classification, the invoice-derived service still disagreeing, a July credit note not moving June, a second tenant's R7 500 never leaking in, a clean period filable, a mixed-rate journal refused on the 15% check, a negative period refused. `tests/unit/sars/efiling-submission.test.ts` — 23 passed. Full unit suite with `DATABASE_URL` unset: 9 319 passed, and the 10 failures are the same ones origin/master's full run has. Three mutation checks in `green.log`.

**Migration/rollback.** None. Revert the two commits.

**Historical data.** Drafts saved before this hold invoice-derived `form_data`. Nothing reached SARS — the ISV channel is dark without `SARS_EFILING_ENABLED`. Read-only scope query, NOT run against production:
```sql
SELECT s.id, s.company_id, s.period_start, s.period_end, s.status,
       (s.form_data->>'field5_outputVAT')::NUMERIC      AS saved_output_vat,
       (s.form_data->>'field2_zeroRatedSupplies')::NUMERIC AS saved_zero_rated
FROM sars_submissions s
WHERE s.form_type = 'VAT201'
  AND EXISTS (SELECT 1 FROM credit_notes cn
              WHERE cn.company_id = s.company_id
                AND cn.status NOT IN ('cancelled','void','voided')
                AND cn.credit_date BETWEEN s.period_start AND s.period_end)
ORDER BY s.period_start DESC;
```
Every row returned was saved on figures excluding its period's credit notes; re-generate the period. Nothing is rewritten here.

**Limits.** A journal mixing a taxed and a nil-rated line still reports its whole base on field 1: `deriveVatBoxes` splits base pro-rata by tax and neither invoice items nor credit notes carry a per-line VAT code, so no available basis can split it. It is now blocked from filing rather than filed silently, and the 15% variance names it. `outputInvoices`/`inputInvoices` stay the period's invoices, so the detail list does not add to the boxes where credit notes exist. No period lock on this route: a closed period re-renders today's ledger, not what was filed. A GET now runs the VAT-journal scan plus the invoice queries plus the nil-rated query.
