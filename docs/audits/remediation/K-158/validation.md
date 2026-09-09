# K-158 — a VAT registration number is stored as a VAT code

- **Claim (medium):** the captured registration number becomes the supplier default VAT code.
- **Corrected trigger:** the defect is real; the destination in the claim is wrong. `pages/api/accounting/capture/[id]/post.ts:182` passes `vatCode: codingRule?.defaultVatCode ?? extracted.vendorVatNumber ?? null` to `recordCoding`, so a VAT *registration* number (e.g. `4123456789`) is supplied where a VAT *code* (`standard`, `zero_rated`, `exempt`) belongs. It does **not** reach `supplier_coding_rules.default_vat_code` from this route: `entry.glAccountId` is always the rule's own GL account, so `glMatches` is true and neither the seed branch (`supplierRulesService.ts:207`) nor the drift branch (`:235`) executes. It lands in `supplier_coding_history.vat_code` (`:178`), which is `VARCHAR(20)` and accepts it without truncation.
- **Disposition:** `confirmed` (with the corrected destination).

## Evidence
- Files unchanged between 5661d6f0 and origin/master.
- Downstream consumer: `provisionalPostingService.predictFromHistory` (`:95-134`) reads `supplier_coding_history.vat_code` for the supplier and picks the **mode** across the last N rows. That prediction becomes `requestedVatCode` at `:224`, and `:230` decides `const hasVat = guarded.vatCode === 'standard'`. A registration number is not `'standard'`, so `netAmount = totalAmount`, `vatAmount = 0`, and the VAT line is omitted entirely (`:246-250`). The file's own comment at `:214` calls this "the third unattended poster" — it posts with nobody watching.
- RED: `tests/integration/k158-vat-registration-number-as-vat-code.int.test.ts` — 1 failed / 1. Log: `red.log`. It drives the real route end to end through `withAuth`/`withCsrf`, gets 200, and finds `supplier_coding_history.vat_code = '4123456789'`.

## Harm
Input VAT is not claimed on provisional bank postings for any supplier whose coding history has been polluted, and the pollution accumulates with every capture post that runs before a VAT code is set on the rule. The mode vote means a handful of polluted rows is enough to outvote the correct ones.

## Proposed minimal fix
Delete the ` ?? extracted.vendorVatNumber` fallback at `pages/api/accounting/capture/[id]/post.ts:182` — a missing default VAT code should stay null, which `predictFromHistory` already skips (`:122` ignores falsy `vat_code`). One line. Optionally add a CHECK or a normaliser on `recordCoding` so `vat_code` can only take a known code, which would have caught this at the boundary.

## Historical-data impact
Existing history rows carry registration numbers and are already steering predictions:

```sql
SELECT company_id, supplier_id, vat_code, COUNT(*) AS rows_
FROM supplier_coding_history
WHERE vat_code IS NOT NULL
  AND vat_code NOT IN ('none','standard','zero_rated','exempt')
GROUP BY 1,2,3 ORDER BY 4 DESC;
```
Those rows should be set to NULL, not deleted, so the GL-account vote they also carry survives. Then re-check provisional journals posted for the affected suppliers for a missing input-VAT line:

```sql
SELECT bt.id, bt.company_id, bt.transaction_date, bt.amount, bt.provisional_je_id
FROM bank_transactions bt
JOIN gl_journal_entries je ON je.id = bt.provisional_je_id
WHERE je.posting_agent LIKE 'ai%' AND bt.predicted_supplier_id IN (<suppliers from the query above>)
  AND NOT EXISTS (SELECT 1 FROM gl_journal_lines l
                  WHERE l.journal_entry_id = je.id AND l.vat_type = 'standard');
```
Correcting those is an accounting decision, not a code change — do not adjust journals without instruction.

## Risks
Nulling history `vat_code` values changes what `predictFromHistory` returns for those suppliers: it will fall back to no VAT prediction until real codes accumulate. That is the correct conservative direction (the guard at `:222` already denies VAT it cannot justify), but it will visibly change predictions in the bank-transaction UI.
