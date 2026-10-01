# K-154 — one ledger invoice matches many supplier-statement lines

- **Claim (medium):** the statement matcher does not consume a matched invoice, so one bill satisfies several statement rows.
- **Corrected trigger:** confirmed as stated, and it fires on both branches. `buildInserts` (`supplierStatementMatchHelper.ts:171-201`) hands the *entire* `invoices` array to `matchLine` on every iteration and only records the winner in `matchedIds`; nothing is removed. Two statement lines carrying the same reference both return `{confidence: 1.0, mismatchReason: null}` for the same invoice, and two equal-amount/equal-date lines both fuzzy-match `invoices[0]` (line 109-113 uses `.find`).
- **Disposition:** `confirmed`.

## Evidence
- Read at `git show origin/master:src/modules/accounting/services/capture/supplierStatementMatchHelper.ts`; file unchanged between 5661d6f0 and origin/master (`git log --oneline 5661d6f0..origin/master -- <path>` empty).
- Reachability: `supplierStatementReconService` is the only caller and drives both the create and rematch paths from the supplier-statement reconciliation UI.
- RED: `tests/unit/services/capture/k154-statement-match-double-consumption.test.ts` — 2 failed / 2. Log: `red.log`.
  - exact-reference case: 2 inserts claim the single invoice (expected 1).
  - fuzzy case: `matchedIds.size` is 1 for 2 genuinely-present invoices, and the unclaimed one is emitted as `missing_in_statement`.

## Harm
The reconciliation is wrong in both directions at once: a supplier's duplicate charge is reported as cleanly matched, and a real ledger invoice is reported as absent from a statement that does list it. A user clearing "missing" exceptions is being pointed at the wrong rows.

## Proposed minimal fix
In `buildInserts`, keep a working pool: `const pool = [...invoices]`, pass `pool` to `matchLine`, and on a non-null `invoiceId` splice that invoice out of `pool` before the next line. `matchedIds` and `buildMissingInvoices` then need no change — `matchedIds` already holds exactly the consumed set. Roughly 4 lines in `supplierStatementMatchHelper.ts`; `matchLine` itself stays pure and untouched.

## Historical-data impact
Existing `supplier_statement_lines` rows are wrong where a reconciliation had repeated references or repeated amount/date pairs. Read-only probe (run on a non-production copy first):

```sql
SELECT reconciliation_id, matched_invoice_id, COUNT(*) AS lines_claiming_it
FROM supplier_statement_lines
WHERE matched_invoice_id IS NOT NULL
GROUP BY 1, 2 HAVING COUNT(*) > 1
ORDER BY 3 DESC;
```
Rows returned are reconciliations whose match column needs re-running after the fix. No GL was posted from this path, so no journal correction is implied.

## Risks
Consuming invoices makes the result order-dependent: the first statement line to claim an invoice wins. That is the correct behaviour for a statement walked top-to-bottom, but a rematch of the same statement in a different line order can now produce a different (still self-consistent) assignment.
