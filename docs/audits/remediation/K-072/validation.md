# K-072 — receipt-to-journal always claims input VAT

**Claim.** Input VAT is claimed even on the meals and entertainment the same function
deliberately routes to account 5600. (`receiptToJournalService.ts:56`, audited at `5661d6f0`;
file unchanged on `origin/master`.)

**Disposition: confirmed.**

**Evidence (read).** `MERCHANT_PATTERNS` (`:56-69`) maps restaurant merchants to code `5600`
with `type: 'meals'`, and `parseReceiptType` (`:155`) returns that type. But
`buildExpenseJournalFromReceipt` (`:139-143`) emits three legs unconditionally, one of them
`{ accountId: vatInputAccountId, debit: vatAmount }`. The receipt type it can compute is never
consulted. Section 17(2)(a) of the VAT Act denies input tax on entertainment.

**Reachability.** Two live routes post the returned lines through `createJournalEntry`:
`pages/api/accounting/receipt-to-journal.ts:86` (source `auto_expense_receipt`, auto-posted when
`shouldAutoPostReceipt` passes at `:88`/`:148`) and
`pages/api/accounting/capture/[id]/post-expense.ts:209`. Neither calls a VAT guard.
The lines carry no `vatType` field, so `scripts/ci/check-vat-guard-coverage.ts` — which scopes on
`VAT_FIELD` or a rate constant (`scripts/ci/vatGuardRules.ts:37-46`) — does not see this path at
all. Existing guard machinery (`resolveRuleVatCode`, used by `autoPostGateService.ts:312`)
already implements the entertainment denial for the bank paths.

**Evidence (executed).** `tests/unit/services/k072-receipt-entertainment-vat.test.ts` —
4 tests, **2 failed, 2 passed**. Failing: "does not debit VAT Input on an entertainment receipt"
(got 150, expected 0) and "charges the full VAT-inclusive amount to the expense account"
(got 1000, expected 1150). Passing guards: the classification is `meals`, and a Waltons receipt
still claims its R150. Output: `red.log`.

**Proposed minimal fix.** In `buildExpenseJournalFromReceipt`, call `parseReceiptType(extracted)`;
when it is `'meals'`, charge `total` to the expense leg and omit the VAT-input leg. Key off the
receipt type, not the account code — `travel` and telecoms also map to 5600 and their input VAT
is claimable.

**Historical-data impact.** Read-only detection query for journals already posted:

```sql
SELECT je.id, je.entry_date, je.description, jl.debit
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id
WHERE je.company_id = $1
  AND je.source = 'auto_expense_receipt'
  AND ga.account_code = '1140' AND jl.debit > 0
  AND je.description ~* '(spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|restaurant|cafe)';
```

Each hit is an over-claimed input VAT line needing a VAT201 adjustment. Not run — production is
out of scope for this validation.

**Risks.** The fix moves VAT into the expense leg, so the entry still balances and the
routes' pre-check at `receipt-to-journal.ts:132` stays satisfied.
