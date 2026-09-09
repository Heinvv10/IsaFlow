# K-072 — receipt-to-journal claimed input VAT on entertainment

**Trigger.** `buildExpenseJournalFromReceipt` emitted three legs unconditionally, one of them
`{ accountId: vatInputAccountId, debit: vatAmount }`. The receipt type it computes itself
(`parseReceiptType` → `'meals'` for restaurant merchants) was never consulted. VAT Act
s17(2)(a) denies input tax on entertainment.

**Before.** Spur receipt R1 150: expense 5600 debit 1 000, VAT Input 1140 debit 150, bank
credit 1 150. The 150 was an unclaimable input-tax deduction, posted unattended by both
callers under their confidence gates.

**After.** The builder runs the receipt type through `applyVatDenial` — the same s17(2)(a)
funnel the bank paths use, and the one place that funnel is allowed to coerce rather than warn,
because nobody is watching an auto-post. On `'meals'` the VAT leg goes to zero and the expense
leg carries `subtotal + vatAmount`. Both routes already drop zero-value legs, so the journal
reaches the ledger with two lines and no VAT-input line at all. The denial keys off the receipt
TYPE, not the account code: `travel` and telecoms map to 5600 too and their input tax is
claimable.

**Files.** `src/modules/accounting/services/bank/receiptToJournalService.ts` only. The two
routes and `scripts/ci/check-vat-guard-coverage.ts` are untouched — an earlier attempt tagged
the lines with `vatType`, which pulled both routes into the VAT-guard gate's scope and needed
two allowlist entries to pass. Tagging is not part of this defect, so it was dropped and the
gate is unchanged at 14 allowlisted paths.

**Tests.** `tests/unit/services/k072-receipt-entertainment-vat.test.ts` (8) and
`tests/integration/k072-receipt-entertainment-vat.int.test.ts` (4, real Postgres). Adjacent
cases: a hotel sharing account 5600 keeps its claim, an unclassifiable merchant keeps its
claim, a meals receipt whose VAT was derived rather than extracted is still denied, and another
tenant's document writes no journal. Mutation proof in `green.log`.

**Migration.** None. **Rollback.** Revert the commit.

**Historical impact.** Journals already posted by this path over-claim input VAT. Read-only
detection, not run here:

```sql
SELECT je.id, je.entry_date, je.description, jl.debit
FROM gl_journal_entries je
JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
WHERE je.company_id = $1
  AND je.source = 'auto_expense_receipt'
  AND ga.account_code = '1140' AND jl.debit > 0
  AND je.description ~* '(spur|nandos|steers|mcdonald|kfc|wimpy|ocean basket|mugg|uber ?eat|restaurant|cafe|coffee)';
```

Each hit needs a correcting journal and a VAT201 adjustment. The population is small: the
`auto_expense_receipt` source only became postable at migration 509.

**Limits.** The denial is only as good as `MERCHANT_PATTERNS`. A restaurant the regex does not
recognise classifies as `general` and keeps its claim. This fix does not consult
`gl_accounts.vat_input_denied`, so a company that flagged its own entertainment account gets no
benefit on this path.
