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

**Tests.** `tests/integration/k052-reclassification-onto-header-account.int.test.ts` — 12 tests,
real disposable Postgres: the header target refused; the report already omits that account; a
level-3 leaf still admitted; a level-1 leaf admitted with another tenant's child under it ignored;
the same target from another tenant still reads `NOT_FOUND` rather than the header refusal; a
level-3 target that HAS children admitted; a level-2 expense header admitted; a NULL-level target
refused with "level 1", not "level 0" or "NaN"; and a two-connection proof that a concurrent
`createAccount` under the target cannot commit inside the guard's window (`55P03`). Three more,
all run with NO request transaction — the one instrument that can see whether the guard locked,
because `lockGlAccountsForUpdate` refuses to run outside one: a preview reaches a verdict (it
takes no lock), a preview still REFUSES a header target (the lock is what the preview drops, not
the rule), and a write-path EXPENSE target reaches a verdict (the type narrowing). Plus
`tests/unit/mcp/reclassificationTools.test.ts` — a `GL_ACCOUNT_LOCK_TIMEOUT` from the plan is
rendered as the pre-write refusal that names the account, and anything else still rethrows.

**Concurrency — WRITE PATH, AND BOTH SIDES.** The guard's verdict has to survive until the lines
are written, and this path locks no account of its own accord: `lockReclassLinesForUpdate` takes
the journal LINES, and the write (`UPDATE gl_journal_lines SET gl_account_id = target`) takes only
FOR KEY SHARE on the target through `gl_accounts_parent_account_id_fkey` — which does NOT conflict
with the FOR KEY SHARE a concurrent `createAccount` needs. So `admitReclassification` takes
`FOR UPDATE` on the target itself, **on the write path only** (`lockCandidateLines`, the same flag
that decides the line lock) and only for targets the leaf rule can bite. A preview holds nothing:
it would otherwise block every real batch and every merge naming the account, to protect a verdict
nothing is about to act on, and its own refusal would arrive as GENERIC_FAILURE.

One lock only ORDERS the two transactions; it does not decide them. `createAccount` formed its
verdict BEFORE its INSERT took FOR KEY SHARE and never re-read, so it lost the race and won the
outcome: blocked at the INSERT, then committing a child onto an account that had acquired posted
lines while it waited. `assertParentUsable` therefore takes the mirror `FOR UPDATE` on the parent
BEFORE its posted-lines read, under the same narrowing, so whichever transaction is second reads
the settled row and refuses. Both paths take the ACCOUNT lock before any line lock, and each takes
at most one account row here, so no cycle exists between them; `lock_timeout` stays 5s. The merge
path's argument for needing no lock does not transfer to either.

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
edited. The guard reads the reports' predicate as it stands today. A PREVIEW can still be
overtaken by a batch or a chart edit that commits before the caller acts on it, exactly as a report
can — that is the deliberate price of a lock-free preview, and the write path re-forms the verdict
under the lock.
