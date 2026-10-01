# K-087 — Opening-balance import zeroes every negative balance

**Claim.** Both sides use `balance > 0 ? balance : 0`, so a negative balance posts as zero and the
totals check cannot detect it.

**Corrected trigger.** The first half is right, the second is wrong.
`migrationOpeningBalanceService.ts:62-71` builds
`debit: isDebitNormal && openingBalance > 0 ? openingBalance : 0` and the mirror for credit, so an
account carrying a balance CONTRARY to its normal side — a bank in overdraft, a supplier in debit,
a negative contra — becomes a 0/0 line. `parseBalance` (migrationParserService.ts:85-90) strips
only `R $ ,` and whitespace, so the minus sign survives every source parser.
But the result is never silent: either the totals check at line 82 rejects a trial balance that
actually foots, with a message that misstates the operator's own figures, or — when the discarded
contras cancel — `validateJournalEntry` refuses the entry with "A line must have a non-zero debit
or credit amount". **Every path is a hard failure; no wrong balance can be posted.** The defect is
that a legitimate migration cannot be imported and the error blames the source data.

**Disposition: confirmed (corrected trigger — availability, not data corruption).**

**Evidence.** RED integration test, real PostgreSQL, service driven inside an `als` request
transaction:
- receivables +1 000, bank −400, payables +600 (a source that foots) →
  `source trial balance does not sum to zero — debits R1000.00 vs credits R600.00`;
- bank −500 and payables −500 (contras that cancel) →
  `Invalid journal entry: Line 1: A line must have a non-zero debit or credit amount; Line 2: …`.
Log: `red.log`.

**Reachability.** `POST /api/accounting/migration-execute` → `executeMigration`
(migrationExecuteService.ts:106) → `postOpeningBalances`. Any tenant importing a Xero, QuickBooks
or Pastel trial balance that contains one contra-side balance.

**RED test.** `tests/integration/k087-opening-balance-negative-zeroed.int.test.ts` — 2 failed / 2.

**Proposed minimal fix.** Post the balance on the side its sign implies, in the two line
expressions at migrationOpeningBalanceService.ts:64-70: let
`onNormalSide = acct.openingBalance >= 0`, then
`debit = (isDebitNormal === onNormalSide) ? |openingBalance| : 0` and the mirror for credit.
Keep the `!== 0` filter at line 44 so genuinely zero rows still produce no line.

**Historical-data impact.** None stored — the import throws before `createJournalEntry` writes
anything, and `postOpeningBalances` is documented as all-or-nothing. Affected tenants are those
whose migration failed, not those with wrong numbers. Read-only check:
```sql
SELECT company_id, source_system, started_at, errors FROM migration_sessions
 WHERE errors::text ILIKE '%does not sum to zero%'
    OR errors::text ILIKE '%non-zero debit or credit%';
```

**Risks.** None beyond the two expressions; the balance check at line 79-86 then sees the real
totals and keeps its refusal for sources that genuinely do not foot.
