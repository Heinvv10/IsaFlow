# K-031 — SARS e-filing files the old invoice-derived VAT201

**Claim (AA C1):** e-filing and the on-screen VAT201 call `generateVAT201`
while the export and MCP tools use the ledger-derived service, so the filed
return can differ from the ledger.

**Corrected trigger:** the divergence is real and measurable, but the sharp end
is NOT the ISV filing call. Two corrections:
1. `generateVAT201` reads `customer_invoices`, `supplier_invoices` and
   `supplier_invoice_items` only. It never reads `credit_notes`, VAT
   adjustments, or manual journals, so every credit note in the period is
   missing from the return it produces.
2. The ISV submit path is doubly gated today — `getEfilingConfig()` returns
   null unless `SARS_EFILING_ENABLED=true` (the channel is dark), and the
   server-side exceptions gate blocks filing whenever field5/field10 differ
   from the GL VAT control movement by more than a cent. The UNGATED exposure is
   `pages/api/accounting/sars/sars-vat201.ts`: GET renders the invoice-derived
   figures on screen, and POST persists them as the draft submission record.

**Disposition: confirmed** (divergence reproduced; reachability qualified above).

## Evidence (`git show ebeac9ca:<path>`)
- `sarsEfilingSubmissionService.ts:16,128` — imports and calls `generateVAT201`,
  then strips the invoice arrays and submits the rest as the SARS field payload.
- `vat201Service.ts:60-243` — the three source queries and the field
  arithmetic. `grep` for `credit_note` in that file returns nothing.
- `vat201ExportService.ts:1-23` — the export is fed from `getVat201Report`
  (journal-derived) precisely so "the exported return is the same one the 15%
  check was run against". `src/lib/mcp/tools/vat.ts:65` and
  `vatReports.ts:56,145` use the same ledger-derived service.
- `vatExceptionsService.ts:222,240-260` — the pre-filing recon compares
  `field5`/`field10` against `findVatControlMovement`. Note what it does NOT
  compare: fields 1, 2, 3, 4 and the 6-9 input splits are never reconciled to
  the ledger, so a return can pass the gate with ledger-inconsistent bases.
- `sarsEfilingConfig.ts:50-56` — channel dark without the three env vars.
- Files unchanged between 5661d6f0 and ebeac9ca.

## RED test
`tests/integration/k-031-efiling-vat201-source.int.test.ts` — 1 failed / 1 total.
One posted R10 000 + R1 500 sales invoice and one approved R1 000 + R150 credit
note, both in June 2026. The ledger-derived boxes return R1 350 of output VAT;
`generateVAT201` returns R1 500. Fails for the claimed reason — the path that
would be filed is R150 higher than the ledger.
Output: `docs/audits/remediation/K-031/red.log`.

## Proposed minimal fix
Make one service authoritative. Replace the `generateVAT201` call at
`sarsEfilingSubmissionService.ts:128` and both calls in
`pages/api/accounting/sars/sars-vat201.ts` with `getVat201Report`, mapping its
boxes to the field1..field11 shape in one shared adapter (the export already
does the equivalent through `buildVAT201Payload`). Keep `generateVAT201` only
as the exceptions report's invoice-side input, which is what the recon needs it
to be.

## Historical-data impact
Draft VAT201 submissions saved through the POST route carry invoice-derived
figures. Scope query (read-only):
```sql
SELECT s.company_id, s.period_start, s.period_end, s.status
FROM sars_submissions s WHERE s.form_type = 'VAT201'
ORDER BY s.period_start DESC;
```
Re-derive each period with the ledger-derived report and compare; any period
containing a credit note or a manual VAT journal will differ. No return has been
filed through the ISV channel (it is dark), so nothing has reached SARS from
this path.

## Risks
Switching the source changes the numbers users see for closed periods. Pair the
change with the period lock in `vatPeriodLockService` so a filed period keeps
showing what was filed.
