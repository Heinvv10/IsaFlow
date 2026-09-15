# K-029 round 4 — the follow-up review of `c5e566fb`

**MEDIUM-D — `lifeExpiredNote` was computed, attached, and read by nothing.**
The note went onto the plan row and every production path dropped it: the MCP
tool builds `skipped` from rows with a non-null `skipReason` and a life-expired
row is postable; the dry run reported it under its own generic wording, which
says the asset "has no policy depreciation left" when the truth is the opposite
— it has a balance the run will never charge; and the REST route's
`DepreciationRunResult` had no field for it. Worse, an expired asset with no tax
charge either was counted as an anonymous `+1` to `skipped` and left `results`
entirely. Now wired into all three:

- `DepreciationRunResultRow.lifeExpiredNote` carries it, so the REST response
  has it and the MCP tool maps it to `life_expired` on each result.
- The both-tracks-zero branch pushes a row instead of skipping silently.
- The preview uses the note as the `subledger_row_only_no_journal` detail when
  one is set, replacing the wording that contradicted it.

**LOW-E — the export lost its row bound.** The dead self-fetch passed
`limit=500`; the direct query had none, so a large register built its whole CSV
in memory as one string. Bounded at 5 000 rows, and the query asks for one more
than that so an overflow is distinguishable from a full page: a truncated
export ends with a `TRUNCATED` row rather than stopping quietly.

**LOW-F — `buildDepreciationCsv` had no fallback on `accumulated_depreciation`.**
The route's own SELECT COALESCEs it, but the function is exported and a caller
passing a row without the column got `NaN` in two columns. Reads as zero now.

**LOW-G — two files sat within four lines of the 300-line cap.** Split at their
natural seams, with re-exports so no importer changed:
`policyDepreciation.ts` takes the period calculator out of
`depreciationMethods.ts` (138 / 180), and `depreciationRunQueries.ts` takes the
run's three SQL reads out of `depreciationRunPlan.ts` (218 / 91), which also
leaves the planner testable without a database.

## Tests

7 integration and 148 unit tests pass. New: the note reaching the dry-run detail
and the run result, a fifth fixture asset whose policy AND tax tracks are both
exhausted so the anonymous-skip branch is exercised, the export's truncation
marker in both directions, and the missing-column fallback. Six mutations —
dropping the note from the result, restoring the anonymous skip, reverting the
preview wording, disabling truncation, removing the fallback, and restoring the
unbounded true-up across the file split — each turn a suite red.

## Limits

Unchanged from round 3: `calculateTaxDepreciation` has no life-expiry check, so
an expired asset stays in `postable` rather than being skipped, which is why the
note rides on a posting row rather than a skip reason.
