# K-029 round 6 — the follow-up review of `9662f5ac`

**MEDIUM-K — a genuine posting failure on a life-expired asset read as
"No charge". New in `9662f5ac`.** `entryId: null` covers three different
outcomes: no journal because the charge is zero, no journal because the life has
expired, and the period rolled back. `runOutcome` tested `entryId` then the
note, so a row that was both life-expired and a rollback took the note branch
and rendered grey. `postDualDepreciationToLedger` can fail on the subledger
UPSERT or the tax journal even when the policy charge is zero, so it is
reachable. It compounded with the summary line, which showed Processed, Skipped
and Total but never `glFailed` — so such a failure was invisible on the page in
both places at once.

The row shape now says which: `DepreciationRunResultRow.glFailed` is explicit
and set at all three push sites, `runOutcome` tests it first, and the summary
line carries the count, red when non-zero. The MCP tool emits `gl_failed` per
result alongside the count it already returned.

While there: the fallback branch tested `lifeExpiredNote`, so an asset whose
POLICY track is finished while its tax track still posts — no note, no entry —
also rendered red. It now keys on `policyDep === 0`, which is the actual
question being asked, and covers both.

**LOW-L — `monthlyCharge` substituted today for a missing purchase date**, so
the asset looked bought this month, the first-month pro-rate fired, and the
column showed a partial charge: a number, and the wrong one. It returns null
now and the cell shows an em dash.

**LOW-M — the round-5 commit message named the flaky tests wrongly.** It called
them "the two `pages/_app.tsx` component tests"; that is their describe title,
not their filename. The files are
`tests/unit/components/serviceWorkerExclusion.test.tsx` and
`tests/unit/components/shareProviderFetches.test.tsx`. Corrected here and in
green.log, since the commit cannot be amended. The flake itself is not from this
work: a full component run with the round-5 test file REMOVED still failed one
of them.

## Tests

`depreciationRunResults.test.tsx` gains three (8 total): a fifth fixture row
that is life-expired AND rolled back reads "GL Failed" on its own line, the
summary line shows the count, and the register shows an em dash for a null
purchase date. New `tests/unit/services/assets/depreciationRunResultRows.test.ts`
(3) pins the service half with `postDualDepreciationToLedger` mocked — the
component fixture supplies its own rows, so it cannot catch a service that stops
setting the flag. Four mutations, each red on the suite that owns it: page
precedence, the service flag, the summary count, and the pro-rated guess.
