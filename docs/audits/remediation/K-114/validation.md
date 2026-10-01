# K-114 — import preview reports balance over only the valid rows

**Claim.** Totals accumulate inside the valid branch, so `isBalanced` describes a subset of the file.

**Corrected trigger.** Confirmed as written. The audit is also right that this is a misleading
preview, not a bad post: `importJournalEntries` re-validates per group on the execute path.

**Disposition: confirmed.**

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master -- glImportService.ts` is empty.
- `git show origin/master:src/modules/accounting/services/gl/glImportService.ts:156-163` —
  `const valid = errors.length === 0; if (valid) { validCount++; totalDebit += debit; totalCredit += credit; } else { errorCount++; }`
- `:169-179` — `isBalanced` is derived from those two subset sums and returned in the summary.
- RED: `tests/unit/services/k114-import-preview-balance-subset.test.ts` — 1 test, 1 failed.
  A DR 1000 / CR 1000 / CR 500-on-a-misspelt-code file reports `errorCount` 1, `validCount` 2,
  and `totalCredit` 1000 instead of 1500. Log: `red.log`.
- Mutation check stated in the test: moving the two `+=` out of the `if (valid)` branch turns it green.

## Reachability
The preview endpoint behind the GL import wizard. Every file containing at least one rejected row
that carries an amount is affected, which is the normal case for a first upload.

## Proposed minimal fix
`src/modules/accounting/services/gl/glImportService.ts`
1. Move `totalDebit += debit; totalCredit += credit;` above the `if (valid)` branch so they cover
   every parsed row.
2. Keep `validCount` / `errorCount` where they are.
3. Optionally report `validDebit` / `validCredit` alongside, so the wizard can say "the file does not
   balance; the rows that parsed do" rather than losing that fact.

## Historical-data impact
None. `validateImportRows` writes nothing, and the execute path re-validates per journal group. The
damage is a user committing a file they believed balanced.

## Risks
Rows with an unparseable debit/credit contribute 0 under `Number(x) || 0`, so a file whose amounts are
malformed will still report a total that understates. Worth stating in the summary copy.
