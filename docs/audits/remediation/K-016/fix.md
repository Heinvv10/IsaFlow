# K-016 — fix

**Trigger.** `allocateTransaction(..., 'supplier'|'customer', entityId, vatCode='standard')` — bank
screen, `bank-transactions-action.ts:118`, or the MCP allocation tools.

**Before → after.** The line was split 15% exclusive: AP/AR moved by the NET while the bank leg and
the payment document carried the GROSS, plus a VAT leg. R115 of cash relieved AP by R100, stranded
R15 there and re-claimed input tax the bill already claimed. Now a settlement with an entity posts
gross, no VAT leg, no `vat_type` on the control leg. The `account` arm (including a supplier call
with no entity, which falls through to it) is unchanged and still splits.

**Files.** `src/modules/accounting/services/gl/settlementVat.ts` (new, 20 lines) —
`isControlAccountSettlement`, the one predicate both posters use.
`src/.../bank/bankAllocationService.ts` — `hasVat` and `mapVatType` gated on it; `vatAccountKey`
simplified to the direction rule, now the account arm's only case.

**Tests.** `tests/integration/k016-bank-allocation-vat-net-control-account.int.test.ts` 1/1 real DB.
`tests/integration/k016-k017-settlement-vat-adjacent.int.test.ts` 5/5 real DB — attended account arm
still splits, account rule still splits, customer receipt gross, supplier refund gross, cross-tenant
posts nothing; all assert balanced journals. `tests/unit/services/bankAllocationSign.test.ts` 13/13:
three tests asserted WHICH VAT account a settlement reached for; that line is gone, so they now
assert no VAT leg, gross control leg, `vatType` undefined, two lines. Suite 9323 passed / 0 failed;
`tsc --noEmit` and `eslint` on changed src clean.

**Mutation.** Predicate forced `false` → 4 of 7 integration tests RED; forced `true` → the account
rule control RED. See `green.log`.

**Migration.** None. Rollback: `git revert`.

**Historical data.** Existing journals NOT corrected — every settlement already posted with a VAT
code keeps the stranded balance and the duplicate claim. Read-only, verified to run:
```sql
SELECT je.company_id, je.id, je.entry_date, je.source, je.entry_number,
       SUM(jl.debit + jl.credit) AS vat_leg
  FROM gl_journal_entries je
  JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id
  JOIN gl_accounts a ON a.id = jl.gl_account_id
 WHERE je.source IN ('auto_supplier_payment', 'auto_payment')
   AND a.account_subtype IN ('vat_input', 'vat_output')
 GROUP BY 1, 2, 3, 4, 5 ORDER BY je.entry_date;
```

**Limits.** No correcting journal proposed — an accounting decision, not a code one. Reversal still
unwinds an affected allocation as posted, which is correct. **A prepayment is knowingly out of
scope**: the predicate covers every supplier/customer allocation, not only those settling an
existing document, so cash received in advance can no longer carry output tax on any path even
though s9(1) puts the time of supply at the earlier of invoice or payment. Reach is small — the
allocation screen and both rule forms render N/A for these types, leaving only the MCP tools
able to express it — and posting a deposit properly needs an advance-payments liability account
this module does not model. Raise the output tax on the invoice instead. `bankAllocationService.ts`
also stands at 683 lines against the 300-line cap; it was 673 on master, so this moves the wrong
way without introducing the problem. Flagged for whoever extracts the allocation arms.
