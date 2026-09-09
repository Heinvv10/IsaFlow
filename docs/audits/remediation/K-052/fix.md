# K-052 fix — a reclassification may not target a header account

**Trigger.** `admitReclassification` / `planReclassification` with a `target_account_id` that is an
asset, liability or equity account whose `level < 3` and which has child accounts.

**Before.** The guard checked ownership, activity, the posting date's period, the VAT201 subtypes
and the VAT lock, but never the target's shape. Nothing downstream did either. Lines moved onto a
header left the balance sheet and the trend report (`level >= 3 OR no children`) while the trial
balance still footed. The fixture's R400 already sitting on such an account is absent from total
assets.

**After.** `admitReclassification` returns a `refused` naming the account and its level, before a
single candidate line is read. Level 3+ targets, childless level 1/2 targets and revenue/expense
targets still pass — the income statement applies no level filter, so refusing an expense header
would have named two reports that never showed the account.

**Files.**
- `src/modules/accounting/services/gl/isReportVisibleLeaf.ts` (shared with K-051; the level
  constant and the account-type set live here)
- `src/modules/accounting/services/gl/reclassification/planGuards.ts` (`ReclassAccount.level` +
  the refusal)
- `tests/unit/services/reclassificationLockSequence.test.ts` — its mocked `getAccountById` fixture
  omitted `level`, so the new guard fell through to a live query.

**NULL level.** `gl_accounts.level` is nullable, and `chartOfAccountsService.mapRow` maps it with a
bare `Number()` — a NULL row arrives as `0`, so `?? 1` never fires and the refusal read
"level 0". `loadAccount` now uses `Number(account.level) || 1`, restoring the column default.

**Tests.** `tests/integration/k052-reclassification-onto-header-account.int.test.ts` — 9 tests,
real disposable Postgres: the header target refused; the report already omits that account; a
level-3 leaf still admitted; a level-1 leaf admitted with another tenant's child under it ignored;
the same target from another tenant still reads `NOT_FOUND` rather than the header refusal; a
level-3 target that HAS children admitted; a level-2 expense header admitted; a NULL-level target
refused with "level 1", not "level 0" or "NaN"; and a two-connection proof that a concurrent
`createAccount` under the target cannot commit inside the guard's window (`55P03`).

**Concurrency.** The guard's verdict has to survive until the lines are written, and this path
never locks the account: `lockReclassLinesForUpdate` takes the journal LINES, and the write
(`UPDATE gl_journal_lines SET gl_account_id = target`) takes only FOR KEY SHARE on the target
through `gl_accounts_parent_account_id_fkey` — which does NOT conflict with the FOR KEY SHARE a
concurrent `createAccount` needs. `assertParentUsable` cannot close it either: at that moment the
target carries no posted lines, the case it deliberately admits. So `admitReclassification` takes
`FOR UPDATE` on the target itself, and only for targets the leaf rule can bite. The merge path's
argument for needing no lock does not transfer here.

**Migration.** None.

**Historical-data impact.** Reclassifications already posted onto a header account have removed
that amount from the balance sheet and the trend report; the ledger itself is right. Read-only
census, not run against production:

```sql
SELECT b.id AS batch_id, b.company_id, ga.account_code, ga.level, COUNT(*) AS lines
FROM reclassification_batch_lines l
JOIN reclassification_batches b ON b.id = l.batch_id
JOIN gl_accounts ga ON ga.id = b.target_account_id AND ga.company_id = b.company_id
WHERE COALESCE(ga.level, 1) < 3
  AND ga.account_type IN ('asset','liability','equity')
  AND EXISTS (SELECT 1 FROM gl_accounts c
               WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id)
GROUP BY b.id, b.company_id, ga.account_code, ga.level;
```

**Limits.** Refusal only — amounts already moved onto a header stay there until the chart is
edited. The guard reads the reports' predicate as it stands today.
