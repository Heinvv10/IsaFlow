# K-051 — account merge into a level 1 or 2 target hides the balance

**Claim.** The merge reparents children onto the target without a level check, turning it into a
header the balance sheet excludes.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)

- `accountMergeGuards.ts:154-208` (`assertMergeable`) refuses on self-merge, inactive target,
  account-type mismatch, reporting-class mismatch, system source, cycle, referenced bank account and
  configuration references. `level` appears nowhere in the file except `MAX_TREE_DEPTH`.
- `accountMergeService.ts:165-173` reparents every direct child of the source onto the target:
  `UPDATE gl_accounts SET parent_account_id = ${targetId} WHERE parent_account_id = ${sourceId}`.
- `balanceSheetService.ts:120-128` selects an account only when
  `ga.level >= 3 OR NOT EXISTS (child with parent_account_id = ga.id)`.
  `trendRowsService.ts:174-175` carries the same predicate.

A target at level 1 or 2 that had no children was on the balance sheet; after the merge it has
children, so it and its whole balance drop out.

## Reachability

`mergeAccounts` is deliberately human-driven (MCP tool / admin), but the merge that motivated the
feature is exactly a legacy-into-current control-account merge, where the current account is often
a summary level.

## RED test

`tests/integration/k051-account-merge-into-header-hides-balance.int.test.ts` — 1 failed.
Total assets are R1,500 before the merge and **R0** after it. The service's own logger fires
`Balance sheet equation violated: Assets ≠ Liabilities + Equity ... imbalance 1500` in the run log.

## Proposed minimal fix

Add one refusal to `assertMergeable`, alongside `target_is_inactive` which it mirrors exactly
(both are "money the reports cannot reach"):

```
if (target.level < 3 && sourceHasChildren) throw new AccountMergeError(..., 'target_becomes_header');
```

Cheaper and stricter: refuse whenever `target.level < 3`, since the target also loses its place the
moment anything is reparented under it. Add `target_becomes_header` to `MergeRefusalCode`.

## Historical-data impact

Any merge already performed into a level <= 2 target has silently removed that account's balance
from the balance sheet and the trend report while leaving the trial balance intact. Read-only
census (`gl_account_merges` records every merge):

```sql
SELECT m.id, m.company_id, m.target_account_id, ga.account_code, ga.level, m.created_at
FROM gl_account_merges m
JOIN gl_accounts ga ON ga.id = m.target_account_id AND ga.company_id = m.company_id
WHERE ga.level < 3
  AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id);
```

Remediation for a hit is a chart edit (give the target a leaf child, or raise its level), not a
ledger correction — no debit or credit is wrong.

## Risks

Refusing every level <= 2 target blocks legitimate merges into Sage-imported charts, where the note
at `balanceSheetService.ts:107-108` says level-1 leaf accounts are normal. The narrower guard
(refuse only when the source has children) keeps those working.
