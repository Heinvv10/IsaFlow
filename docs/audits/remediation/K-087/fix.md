# K-087 fix — opening-balance import zeroes every negative balance

**Trigger.** `postOpeningBalances` built each line as
`debit: isDebitNormal && openingBalance > 0 ? openingBalance : 0` and the credit mirror, so an
account whose balance is CONTRARY to its normal side — a bank in overdraft, a supplier in debit, a
negative contra — became a 0/0 line. `parseBalance` keeps the minus sign, so this reaches the
service from any Xero/QuickBooks/Pastel trial balance loaded through
`POST /api/accounting/migration-execute`. Every outcome is a hard failure: a source that foots is
refused with totals that misstate the operator's own figures, or the discarded contras cancel and
`validateJournalEntry` rejects the zero-value lines. Nothing wrong is stored; the migration simply
cannot be run and the message blames the source data.

**Before / after.** Before: `-400` on a debit-normal bank produced `debit 0, credit 0` and the
error `debits R1000.00 vs credits R600.00`. After: it produces `credit 400`, the journal balances,
and the entry posts. A source that genuinely does not foot is still refused, now quoting the real
totals (`debits R1000.00 vs credits R1100.00`). The `openingBalance !== 0` filter is unchanged, so
a zero row still produces no line.

**Files.** `src/modules/accounting/services/core/migrationOpeningBalanceService.ts` — the two line
expressions plus the sign derivation. No other production file.

**Tests (real PostgreSQL).** `tests/integration/k087-opening-balance-negative-zeroed.int.test.ts`
2/2 (the validator's RED, now green); `tests/integration/k087-opening-balance-adjacent.int.test.ts`
4/4 — non-footing source still refused with the operator's real figures and nothing written;
posted journal balanced with each account's signed balance equal to the source; a second company
untouched; the mirror direction (credit-normal account in debit lands on the debit side) with a
zero balance producing no line. Mutation-proof: production change reverted, 5 of the 6 go RED
(see green.log).

**Migration / rollback.** None. Revert the commit.

**Historical-data impact.** None stored: `postOpeningBalances` throws before `createJournalEntry`
writes, and the function is all-or-nothing. Affected tenants are those whose import FAILED, not
those with wrong numbers. Read-only list of them (NOT run against production here):
```sql
SELECT company_id, source_system, started_at, errors
  FROM migration_sessions
 WHERE errors::text ILIKE '%does not sum to zero%'
    OR errors::text ILIKE '%non-zero debit or credit%';
```

**Limits.** Only the `executeMigration` path (`postOpeningBalances`) derives the side from the
sign. The wizard path (`importOpeningBalances` in migrationImportService.ts) takes explicit
debit/credit columns and never had this defect; it is deliberately untouched here because the
K-015 branch (PR #373) is editing that file.
