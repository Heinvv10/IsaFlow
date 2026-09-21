# K-052 — reclassification can post onto a parent header account

**Claim.** `admitReclassification` never checks that the target is a leaf, and the posting service
has no leaf check either.

**Disposition: confirmed.**

## Evidence (baseline origin/master `0f16391e`)

- `reclassification/planGuards.ts:84-160` (`admitReclassification`) refuses on same-account,
  inverted date range, unknown/foreign account, inactive source or target, `no_period`, closed
  period, VAT201 control subtypes and a filed VAT period. No level or leaf test.
- Nothing downstream adds one:
  `grep -rn "level\|leaf\|parent_account_id" src/modules/accounting/services/gl/reclassification/*.ts`
  returns only prose in comments — three hits, none of them code.
- `balanceSheetService.ts:120-128` selects an account only when
  `ga.level >= 3 OR NOT EXISTS (child with parent_account_id = ga.id)`;
  `trendRowsService.ts:174-175` repeats it.

So a reclassification is free to move posted lines onto a level <= 2 account that has children, and
the moved amount leaves the balance sheet and the trend report while the trial balance still foots.

## Reachability

The MCP `propose_reclassification` / reclassify tools and any caller of `planReclassification`.
Target accounts are supplied by the caller; the only account-shape control is the VAT subtype list.

## RED test

`tests/integration/k052-reclassification-onto-header-account.int.test.ts` — 1 failed, 1 passed.

- Failing: `admitReclassification` admits a level-2 target that has a child (`expected false to be true`).
- Passing, as supporting evidence: R400 already sitting on that header account is absent from the
  balance sheet — total assets read R1,000 against R1,400 of posted asset debits.

## Proposed minimal fix

In `admitReclassification`, after the active checks, refuse a target that the reports treat as a
header. It needs one extra fact per account, so widen `loadAccount`'s projection (or add a small
`isPostable` query) to carry `level` plus "has children", then:

```
if (target.level < 3 && targetHasChildren) return { refused: `${target.code} ${target.name} is a header account ...` };
```

Same predicate as `balanceSheetService`, and the same guard K-051 needs in `assertMergeable` —
worth extracting one `isReportVisibleLeaf(companyId, accountId)` helper used by both.

## Historical-data impact

Any reclassification already posted onto a header account has removed that amount from the balance
sheet and the trend report. `reclassification_batch_lines` records every move, so the census is
exact. Read-only:

```sql
SELECT b.id AS batch_id, b.company_id, ga.account_code, ga.level, COUNT(*) AS lines
FROM reclassification_batch_lines l
JOIN reclassification_batches b ON b.id = l.batch_id
JOIN gl_accounts ga ON ga.id = b.target_account_id AND ga.company_id = b.company_id
WHERE ga.level < 3
  AND ga.account_type IN ('asset','liability','equity')  -- isSubjectToLeafRule: the income statement has no level filter
  AND EXISTS (SELECT 1 FROM gl_accounts c WHERE c.parent_account_id = ga.id AND c.company_id = ga.company_id)
GROUP BY b.id, b.company_id, ga.account_code, ga.level;
```

Column names verified against the fixture schema: `reclassification_batches(company_id, source_account_id, target_account_id)` and `reclassification_batch_lines(batch_id, company_id, source_line_id)`.

## Risks

Sage-imported charts legitimately carry level-1 leaf accounts (`balanceSheetService.ts:107-108`), so
the guard must test level AND children, not level alone, or it blocks ordinary targets.
