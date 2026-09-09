# K-115 — two integrity-check totals are wrong

**Claim.** `deactivated_accounts_with_balance` sums signed amounts over a mixed-sign set; the VAT
check multiplies counts by the number of VAT lines.

**Corrected trigger.** The account half is confirmed as written. The VAT half needs correcting: the
row fan-out inflates the COUNT in every case, but it does NOT inflate the amount merely because a
journal has several VAT lines — those legs all belong to the one transaction and their sum is the
right answer. The amount is over-reported only when SEVERAL bank transactions match lines on ONE
journal, and then it is multiplied by the number of matching transactions.

**Disposition: confirmed** (with the VAT amount trigger restated above).

## Evidence
- Baseline `origin/master` = `31fc2f10`; `git diff HEAD origin/master` is empty for both files.
- `accountChecks.ts:55` selects `ABS(b.balance) > 0.005` across every account type; `:57` totals
  `COALESCE(SUM(f.amount), 0)`. The sibling with the identical shape, `clearingAccountsNotNil:129`,
  uses `SUM(ABS(f.amount))`. `assetAccountsWithCreditBalance:91` also uses the signed sum but its set
  is `balance < -0.005`, uniformly signed, so it is correct.
- `vatChecks.ts:33-42` joins `gl_journal_lines vl` on `journal_entry_id`, once per VAT line, and
  `:44` counts `COUNT(*)` over that fan-out.
- RED: `tests/integration/k115-integrity-check-totals.int.test.ts` — 3 tests, 3 failed. Log: `red.log`.

| case | fixture | reported | correct |
|---|---|---|---|
| A | deactivated asset +500,000, deactivated loan -500,000 | count 2, amount R0.00 | R1,000,000 |
| B | 1 bank transaction, 2 VAT legs of R150 | count 2 | count 1 (amount R300 is right) |
| C | 2 bank transactions matched to 1 journal, R300 of VAT | count 4, amount R600 | count 2, amount R300 |

## Reachability
Both checks are in `INTEGRITY_CHECK_IDS` and run from the integrity-check suite endpoint. Read-only.

## Proposed minimal fix
1. `accountChecks.ts:57` — `COALESCE(SUM(ABS(f.amount)), 0)`, matching line 129.
2. `vatChecks.ts` — aggregate the VAT legs per journal first, then join one row per bank transaction:
   move `vl`/`ga` into a `LEFT JOIN LATERAL (SELECT SUM(ABS(vl.debit - vl.credit)) …) v ON TRUE`
   keyed on `jl.journal_entry_id`, and keep `COUNT(*)` over `bank_transactions`.
3. Divide nothing: `SUM` over the lateral is per-transaction and already correct.

## Historical-data impact
None. Both are read-only reporting queries. The impact is triage: a book with offsetting deactivated
balances has been reporting R0.00 at stake, which reads as "nothing to do". Read-only re-measure per
company after the fix; NOT run against production here.

## Risks
Case C's over-count is only reachable where one journal carries several bank lines. If production has
no such journals the VAT amount is currently correct, and only the count changes — the fix should
still land, because the shape is one batch-payment journal away.
