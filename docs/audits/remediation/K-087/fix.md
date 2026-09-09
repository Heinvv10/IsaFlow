# K-087 fix — opening-balance import zeroes every negative balance

**Trigger.** `postOpeningBalances` built each line as
`debit: isDebitNormal && openingBalance > 0 ? openingBalance : 0` and the credit mirror, so an
account whose balance is CONTRARY to its normal side — a bank in overdraft, a supplier in debit, a
negative contra — became a 0/0 line. `parseBalance` keeps the minus sign, so a contra row reaches the
service from any trial balance loaded through `POST /api/accounting/migration-execute` that is
exported in the normal-side convention (see Limits — a debit-signed export is a different problem
and is still refused). Every outcome is a hard failure: a source that foots is
refused with totals that misstate the operator's own figures, or the discarded contras cancel and
`validateJournalEntry` rejects the zero-value lines. Nothing wrong is stored; the migration simply
cannot be run and the message blames the source data.

**Before / after.** Before: `-400` on a debit-normal bank produced `debit 0, credit 0` and the
error `debits R1000.00 vs credits R600.00`. After: it produces `credit 400`, the journal balances,
and the entry posts. A source that genuinely does not foot is still refused, now quoting the real
totals (`debits R1000.00 vs credits R1100.00`). The `openingBalance !== 0` filter is unchanged, so
a zero row still produces no line.

**Files.** `src/modules/accounting/services/core/migrationOpeningBalanceService.ts` — the two line
expressions plus the sign derivation and the convention comment. No other production file.
`src/modules/accounting/services/core/.claude.md` (+ its generated `AGENTS.md` mirror) — the
service was missing from the file list; adds the sign-convention rule and a recent-changes entry.

**Tests (real PostgreSQL).** `tests/integration/k087-opening-balance-negative-zeroed.int.test.ts`
2/2 (the validator's RED, now green); `tests/integration/k087-opening-balance-adjacent.int.test.ts`
4/4 — non-footing source still refused with the operator's real figures and nothing written;
posted journal balanced with each account's signed balance equal to the source; an
already-imported company unchanged when a second company imports the same account codes; the
mirror direction (credit-normal account in debit lands on the debit side) with a zero balance
producing no line. Mutation-proof against four independent mutants: reverting the expressions,
inverting the side test, and dropping `Math.abs` each turn ALL SIX red; dropping the
`openingBalance !== 0` filter turns two red. No survivors (see green.log).

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

**Limits.**
1. **Sign convention.** The fix reads a negative as "contrary to the account's normal side" — the
   convention `verifyBalances` already reconciles against
   (`isaflowBalance = normal_balance === 'debit' ? net_debit : -net_debit`). A source exported
   debit-signed instead (liabilities carried negative, as some Pastel exports are) puts every
   ordinary credit line on the debit side and is still refused by the totals check. That is not a
   regression — master refused it too — but such a file is not made importable here. The
   convention is now stated in the code and in the module `.claude.md`.
2. **The entry is dated the import date, not the take-on date.** Line 134 uses
   `fmtDate(new Date())`, while the manual path (`openingBalancePostingService`) dates the entry
   at the open period's `start_date` and passes `fiscalPeriodId`. Pre-existing and deliberately
   untouched, but the fix makes it REACHABLE for every contra-carrying import that previously
   always threw, so those take-on balances now land in whatever period covers today. Bounded, not
   fixed: it needs its own candidate, since changing the date changes which period every migrated
   company's opening journal falls in and belongs with the take-on posting work, not with a sign
   correction.
3. **Scope.** Only the `executeMigration` path (`postOpeningBalances`) derives the side from the
   sign. The wizard path (`importOpeningBalances` in migrationImportService.ts) takes explicit
   debit/credit columns, rejects negatives outright, and never had this defect; it is deliberately
   untouched because the K-015 branch (PR #373) is editing that file.
