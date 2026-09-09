# K-029 round 7 — the last finding

**LOW-N — "Processed" counted rows the page labels "No charge".**
`executeDepreciationRun` increments `processed` whenever EITHER track charges at
least a cent, so an asset whose policy track is finished while its tax track
still posts lands in `processed` — and this page renders it "No charge" at
R 0.00. The counter and the row label disagreed at a glance. Pre-existing
counting semantics, but rounds 5 and 6 made it visible: before them the row was
either absent from `results` or painted as a failure, so nobody read it against
the count.

The summary now leads with one number per label, tallied by `outcomeTally`
through the same `runOutcome` that labels the rows, so the two cannot drift:
GL Posted, No charge, GL Failed, then Skipped and Total Assets. Nothing is lost
— every row the run reports lands in `results`, so posted + no charge + failed
equals `processed + glFailed`. `processed` stays in the API payload and the
`processed + skipped + glFailed === total` invariant is untouched; only the
display changed.

## Tests

`depreciationRunResults.test.tsx` gains one (9 total). It asserts each summary
number against the count of that label in the list underneath it — 2 posted,
1 no charge, 2 failed against a fixture whose `processed` is 2, which is exactly
the mismatch that used to lead the summary. Two mutations turn it red: putting
`processed` back at the head of the summary, and tallying on `entryId` instead
of through `runOutcome`, which is the drift the shared helper exists to prevent.

This closes the K-029 review chain. One schedule now backs the run, the dry run,
the MCP tool, the CSV export, the asset detail page and the depreciation page,
and every guard added along the way is mutation-proof.
