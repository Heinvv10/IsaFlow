# K-031 — the VAT201 you see, save and file now comes from the ledger

**Trigger.** `generateVAT201` reads `customer_invoices`, `supplier_invoices` and `supplier_invoice_items` only — never `credit_notes` or manual VAT journals. The route (GET on-screen, POST saved draft) and `submitVAT201ToSars` used it; the CSV/SARS export and the MCP VAT tools already used the journal-derived `getVat201Report`. A period with credit notes showed, persisted and would file a return higher than the books.

**Before/after.** R10 000 + R1 500 invoice and an approved R1 000 + R150 credit note, June 2026. Before: field5 R1 500, field1 R10 000. After: field5 R1 350, field1 R9 000 — the figure the export already reported.

**Files.** New `src/modules/accounting/services/reports/vat201LedgerFields.ts` (80 lines) — `getLedgerVAT201`, the one box→field adapter over `getVat201Report`. `pages/api/accounting/sars/sars-vat201.ts` (GET+POST) and `sarsEfilingSubmissionService.ts` call it. `tests/unit/sars/efiling-submission.test.ts` mock retargeted; `pages/api/accounting/sars/.claude.md` + `AGENTS.md` mirror. `generateVAT201` is deliberately untouched — `vatExceptionsService` needs the invoice population to reconcile against the GL VAT control movement.

**Mapping.** field1 = base of boxes 1+1A, field2 = 2+2A, field3 = 3, field4 = base of 14A/15A, field5 = total output tax, field6 = tax of box 14, field9 = tax of 14A/15A, field10 = total input tax, field7 = the remainder so field6+7+8+9 === field10, field11 = net. field8 (services) is 0: journal `vat_type` has no goods/services split, so that tax sits in field7.

**Tests.** `tests/integration/k-031-efiling-vat201-source.int.test.ts` — 5 passed on the real schema: ledger agreement, input-side footing identity, the invoice-derived service still disagreeing (that gap IS the exceptions finding), a July credit note not moving June, a second tenant's R7 500 never leaking in. `tests/unit/sars` + sarsService + vat201Degraded + vatExceptions — 118 passed. Mutation check in `green.log`: reverting field5 to the invoice source turns 3 of the 5 red.

**Migration/rollback.** None. Revert the commit.

**Historical data.** Drafts saved before this change hold invoice-derived `form_data`. Nothing reached SARS — the ISV channel is dark without `SARS_EFILING_ENABLED`. Read-only scope query:
```sql
SELECT s.id, s.company_id, s.period_start, s.period_end, s.status,
       (s.form_data->>'field5_outputVAT')::NUMERIC     AS saved_output_vat,
       (s.form_data->>'field10_totalInputVAT')::NUMERIC AS saved_input_vat
FROM sars_submissions s
WHERE s.form_type = 'VAT201'
  AND EXISTS (SELECT 1 FROM credit_notes cn
              WHERE cn.company_id = s.company_id
                AND cn.status NOT IN ('cancelled','void','voided')
                AND cn.credit_date BETWEEN s.period_start AND s.period_end)
ORDER BY s.period_start DESC;
```
Every row returned was saved on figures excluding its period's credit notes; re-generate the period for the ledger figure. Nothing is rewritten here.

**Limits.** `outputInvoices`/`inputInvoices` stay the period's invoices, so in a period with credit notes the detail list does not add to the boxes — the exceptions panel explains the gap; a ledger drill-down would swap invoice numbers for journal numbers and is a separate change. No period lock on this route: a closed period re-renders today's ledger, not what was filed. The export carries that lock; this route does not.
