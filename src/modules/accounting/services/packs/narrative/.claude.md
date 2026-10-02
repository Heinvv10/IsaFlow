# services/packs/narrative/

## Purpose
The board pack's derived text: titles, captions, disclosures and board-action bullets. Every string is built deterministically from figures already on the pack. No model output and no free text. (`approved` commentary is a person's, rendered elsewhere; `derived` is this directory.)

## Files
- `derivedSentences.ts`: page titles (`highlightsTitle`, `positionTitle`, `cashTitle`, `scorecardTitle`, `incomeStatementTitle`, ...). Re-exports the files below, so imports did not move.
- `derivedMattersTitle.ts`: page 4's `narrativeTitle` and `failedChecksClause`, which pages 4 and 11 share.
- `derivedTrendsTitle.ts`: page 10's `trendsTitle`.
- `derivedCaptions.ts`: captions under a table, chart or tile row (`scorecardCaption`, `largestMoverCaption`, `trendsCaption`, `positionCaption`, `cashCaption`).
- `derivedTileCaptions.ts`: a tile's movement in words (`deltaWithWord`, `tileCaption`, `NOT_A_POSITIVE_BASE`).
- `derivedBoardActions.ts`: page 4's action panel (`boardActionItems`, line-budgeted like page 11).
- `derivedSignDisclosures.ts`: negative equity, income/cost lines below zero, balances below zero (`impossibleBalancesSentence`).
- `derivedProseFigures.ts`: `money` (a figure into a sentence, always through `inProse`) and `pctChangeClause`.
- `statedRelation.ts`: `profitStanding`, `rankedBy`, `superlativeClause`; the shared way to assert a relation.

## Rules
- **A sentence that states a relation takes the relation's result as an input**, computed from the figures. Testing only the condition that triggered the sentence is how three derived sentences came out false on one company and true on another.
- Money enters prose through `inProse`/`money`; percentages through `pctWithWord`/`formatPctLevel`; a change in a percentage is in points (`deltaWithWord`). Negatives are brackets, never a minus sign.
- A title states what the data did, not how the renderer coped. `assertPageTitleIsAMessage` is a test-time guard and stays one: a dormant company's titles are true and carry no digit.
- Page 4's title counts findings the same way page 11 does; `checkMattersCrossReference` compares them.
- Derived text must hold on companies the demo fixture does not resemble (negative revenue, nil months, closed or stale ledgers). Test on a second shape.
- `figures/packProseIntegrity.ts` refuses sentences that print plumbing; keep wording written for a director.
