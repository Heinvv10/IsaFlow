# v52 — the gate-30 fixes, rendered

Both packs printed through `GET /api/accounting/packs/board/pdf?from=2026-01-01&to=2026-09-07`
(never `scripts/pdf/render-pack.ts`), from a dedicated worktree checked out at the commit under
test with an empty `git status`, on its own dev server. See `provenance.txt`.

12 sheets, A4 portrait (595.92 x 842.88 pt), both companies. No omission footnote on any of the 24.

## D2 — one typeface

`pdffonts`, both packs, every page:

    AAAAAA+IBMPlexSans          pages 1-12
    BAAAAA+IBMPlexSans-SmBld    pages 1-12
    CAAAAA+IBMPlexSans          pages 1-12   (the footer's subset of the same face)
    DAAAAA+IBMPlexSans-Medm     pages 3-12

`LiberationSans` and `NotoSans-Regular` are gone from both files. The gate's own example —
demo page 6, `1 431` in the Cost of sales row and again as its own bar label a centimetre
below — now reports `IBMPlexSans` for both spans.

## D1 — one scale on page 3

Sparkline ink height measured off the vector, in points, against each series' own swing:

| | swing | ink height | pt per unit |
|---|---|---|---|
| demo Revenue     |    37 |  0.84 pt | 0.02270 |
| demo Cash        | 1 506 | 34.57 pt | 0.02296 |
| demo Net profit  | 2 692 | 61.85 pt | 0.02298 |
| BS Net profit    | 1 408 | 20.62 pt | 0.01464 |
| BS Cash          | 3 186 | 46.66 pt | 0.01464 |
| BS Revenue       | 5 535 | 81.05 pt | 0.01464 |

One scale per pack, to five figures. At v51 the demo's 37 and 2 692 were drawn 313 px and
303 px — the same height — and Brightsphere's smaller swing was drawn the deeper; it is now
the shallower, and by the right amount.

The two other-unit tiles (gross margin %, debtor days) keep their own scale and fill their own
boxes, which the sheet states: demo footnote 1 reads *"Revenue, Net profit and Cash share one
y-scale, (1 621) to 1 908, so none of them can look like it moved more than it did. Gross
margin and Debtor days are in other units, each drawn on its own."* Brightsphere draws no
other-unit sparkline, so its copy of the note carries the first sentence and not the second.

## Page fit

Page 3 is the ONLY page whose measurement moved, on any of the twelve fixtures — measured in
vitest, off `pageMm`/`pageBoxMm`, against the same measurement taken in a worktree at
`60b447c3`. Every other row is identical. Page 3 gained headroom on nine fixtures (Brightsphere
live 0.74mm -> 3.30mm, demo 1.65mm -> 4.21mm) and lost 1.33mm on `liveDemoShortPanels`
(3.21mm -> 1.88mm), which pays for both the short-window clause and the other-units clause.
`WIDTH_SAFETY` is untouched.

## Files
`board-demo.pdf`, `board-brightsphere.pdf`, `png-demo/p-01..12.png`, `png-bs/p-01..12.png`,
`t-demo.txt`, `t-brightsphere.txt`.
