# v54 — gate 32: the floor is declared, and the duplicate face is left alone

Both packs printed through `GET /api/accounting/packs/board/pdf?from=2026-01-01&to=2026-09-07`
(never `scripts/pdf/render-pack.ts`), from a dedicated detached worktree at `a7c75e9f` with an
empty `git status`, on its own dev server. See `provenance.txt`.

12 sheets, A4 portrait (595.92 x 842.88 pt), both companies. **No omission footnote on any of
the 24 sheets** (`grep -c "Not printed on this page"` = 0 on both text extracts), and the junk
sweep (`undefined|NaN|Infinity|[object|TODO|{{`) is empty on both.

## F1 — the undisclosed minimum-bar-height floor

### What was wrong

`NIL_STEP_RULE_PX` gives a step whose rect would be under a pixel a one-pixel rule on its
running total, rather than painting nothing. Measured by the gate off v53's content stream —
Brightsphere p6, zero at y=32, k = 5535/129.2 = 42.84 R'000/unit:

| Bar | drawn (u) | implied | printed |
|---|---|---|---|
| Revenue | 129.2 | 5 535 | (5 535) |
| Operating Expenses | 86.7 | 3 714 | (3 717) |
| **Other Income** | **1.0** | **43** | **(1)** |
| Net Profit | 32.8 | 1 405 | (1 408) |

The mark is right — 1 unit is 0.28mm on paper, and 0.023 units renders nothing, which this
pack's own rule reserves for a nil line. The rule was undisclosed, one clause away from the rule
it most resembles.

### What the sheet says now

Page 6, footnote 3, as printed on Brightsphere:

    ... A line with a nil figure for the period is not drawn: Cost of Sales. A line too small to
    draw at this scale is drawn as a hairline, so read its figure from the label rather than
    against the axis: Other Income.

Conditional on the floor having fired, like the sentence beside it:

    grep -c "too small to draw at this scale" t-demo.txt t-brightsphere.txt
    t-demo.txt:0
    t-brightsphere.txt:1

### It is reported by the renderer, not re-derived

The height that trips the floor is pixels of a plot box no caller computes. `waterfallOption`
takes an `onFloored` sink, `buildProfitWaterfallChart` collects it as the SVG is composed, and
`PackChartSpec.flooredBars` carries the labels in walk order —
the same shape `omittedBars` already has, and for the same reason.

`packBridgeFloorIsDeclared.test.ts` reads the DRAWING: on both fixtures `flooredBars` must equal
exactly the bars whose path height the renderer wrote at the floor. Mutation-proved — reporting
every bar reddens three of the five, and removing the floor itself reddens `packNilStepIsDrawn`.

### What it cost page 6: 4mm of bridge, and nothing else

Measured in vitest off `remainingPageMm` and the composed chart, live Brightsphere:

| | bridge | page 6 remaining | footnotes |
|---|---|---|---|
| before | 71mm | 0.78mm | 3 |
| after | 67mm | 0.90mm | 3 |

`profitBridgeAtHeight` grows the bridge into whatever paper the page has left, so two extra
lines of footnote come out of the chart rather than out of the content: nothing is dropped, the
footnote count is unchanged, and no sheet carries an omission notice. Measured off the rendered
PDFs, the bars rescale together — 129.2u to 115.3u on every bar, k 42.84 to 48.0 R'000/u — and
the floored bar is still 1.0u.

### Nothing else on either pack moved

Whitespace-normalised diff of the v53 and v54 text layers:

- **demo** — the extraction timestamp, and one rotated chart label re-bucketed by `pdftotext`.
  No other line differs. The live demo pack floors no bar and declares nothing.
- **Brightsphere** — the two new footnote lines, the extraction timestamp, and the p6 chart's
  rotated labels and one axis label re-bucketed by the shorter plot.

## F2 — both PDFs embed the Regular face twice: it is the footer mechanism, unchanged

`pdffonts` is identical in v53 and v54, on both companies:

    AAAAAA+IBMPlexSans        CID TrueType  Identity-H  emb sub uni  (object 4)
    BAAAAA+IBMPlexSans-SmBld  ...
    CAAAAA+IBMPlexSans        CID TrueType  Identity-H  emb sub uni  (object 8)
    DAAAAA+IBMPlexSans-Medm   ...

`/F8` — the `CAAAAA+` subset — is the FOOTER. Read off the page-1 content stream of
`board-brightsphere.pdf`, every `/F8` run is set at `10 Tf` in `.2118 .2118 .2118 rg` at
`Tm ... 1101`, inside the `0 1090 795 1 re` rule band: the 10pt footer grey on all 24 pages.
`/F4` (`AAAAAA+`) is the body Regular.

The cause is `packFont.ts`'s footer mechanism, which is documented and measured: Chromium draws
`displayHeaderFooter` templates in a document that inherits no stylesheet, and it matches a font
by RESOURCE rather than by family — so the page must load the *identical data URI* the footer is
about to ask for, under its own family name (`IBM Plex Sans Print Footer`, cut from
`IBMPlexSans-Regular.woff2`). Two resources of one face is therefore two subsets, by
construction.

**Left alone, deliberately.** It is invisible on paper, the mechanism is held from both ends by
tests, and collapsing the two resources is the one change that would put the footer back on Noto
Sans in silence.
