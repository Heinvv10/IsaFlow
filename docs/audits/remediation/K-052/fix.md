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

## Round-5 disposition (blind re-review `0d0f4897`, MEDIUM-1)

**Trigger.** `post_reclassification_batch` while another request holds the target GL account
(a merge, a chart edit, or a peer batch) for longer than the 5s `lock_timeout`.

**Before.** `lockGlAccountsForUpdate` issued `FOR UPDATE` directly in the request transaction.
The timeout raises SQLSTATE 55P03, which ABORTS the subtransaction. `planFromArgs` caught
`GL_ACCOUNT_LOCK_TIMEOUT` and RETURNED a toolError, so `registry.call` took the normal-return
path and issued `RELEASE SAVEPOINT` on an aborted subtransaction — 25P02. The agent received
GENERIC_FAILURE, the wording naming the account and asking for a retry was discarded anyway,
and a clean 5s wait was reported as a transaction fault. The catch looked like it worked and
did not.

**After.** Both locks the plan can take run in their own `withSavepoint` — the target account
(`planGuards.ts`, `reclass_target_lock`) and the candidate lines (`plan.ts`,
`reclass_line_lock`, which had the identical latent shape for `RECLASS_LINE_LOCKED`). The
savepoint rolls back before the error reaches the catch, so the transaction is usable when the
toolError returns and the registry can still write its audit row. Same shape as
`snapshotInvoicePdf` (`src/lib/mcp/.claude.md`), and for the same reason: catching a SQL error
does not un-poison a transaction.

Also in this round, `admitReclassification` takes the target lock LAST, below the period,
VAT-subtype and VAT-lock refusals — a request that was never going to proceed no longer holds
the row for the rest of the transaction.

**Tests.** `tests/integration/k052-reclassification-lock-savepoint.int.test.ts` (2, real DB):
a second connection holds the row for the whole 5s, the REAL write tool runs inside
`withSavepoint(savepointNameFor('post_reclassification_batch'), ...)` exactly as the registry
does, the caller receives the refusal naming the account, a later query on the same transaction
succeeds, and nothing was written. `tests/unit/mcp/reclassificationTools.test.ts` moves both
catch tests onto the write tool — the only caller that can reach either code — and adds one for
`RECLASS_LINE_LOCKED`. Mutation: removing the savepoint wrap makes the integration test fail
with `current transaction is aborted`.

**Migration / historical data.** None for K-052.

## Round-6 (blind re-review `31ae8c7da`)

- **MED-3 — the LINE lock's savepoint was unguarded.** `k052-reclassification-lock-savepoint.int.test.ts`
  gains a third case: a second connection holds the seeded `gl_journal_lines` row, the target is a
  childless level-3 asset so `isSubjectToLeafRule` is false and the account lock is skipped, and the
  contended lock is the one in `plan.ts`. Same three assertions: `isError`, `'retry'` in the text,
  `SELECT 1` still returning on the runner transaction. Unwrapping `plan.ts:145` fails it with
  `current transaction is aborted`. 4 tests, 10.8s (two real 5s `lock_timeout`s).
- **LOW-5 — the census in `validation.md` omitted `account_type`.** `isSubjectToLeafRule` applies to
  `asset`/`liability`/`equity` only, so the census reported revenue/expense header batches as
  historically impacted when nothing was lost. Filter added; it now matches K-051's.
- **LOW-4 — a comment in `tests/unit/mcp/reclassificationTools.test.ts` named a file that does not
  exist.** Corrected to `k052-reclassification-lock-savepoint.int.test.ts`.

## Round-10

- **The census was RUN, not asserted.** The reclassification census in this file and in
  `validation.md` was executed against the fixture DB with the population seeded in a rolled-back
  transaction — one `reclassification_batches` + `reclassification_batch_lines` pair whose target is
  a level-2 asset account with a child — and returned **1 row**. Recorded with the other three
  branch censuses in `docs/audits/remediation/K-051/fix.md` under **Census claims, verified by
  execution (round 10)**. No code change.

## Round-11

- **The "trial balance still footed" half of the opening claim was executed.** Until now this file
  asserted in prose that lines on a header account leave the balance sheet while the trial balance
  is unaffected, and only the balance-sheet half was run. `k052-reclassification-onto-header-account.int.test.ts`
  gains a case reading `getTrialBalance` over the same fixture: the header `K052-1100` carries its
  full **R400** there, the statement foots at R1,400 debit = R1,400 credit, and `getBalanceSheet`
  in the case above it reads total assets of **R1,000**. That R400 gap is the defect, and it is why
  a reconciliation that only checks whether the trial balance foots cannot see it. Recorded with
  the other where-it-surfaces claims in `docs/audits/remediation/K-051/fix.md` under **Round-11**.
  No code change.
