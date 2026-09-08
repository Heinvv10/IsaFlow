# v53 — gate 31: the reporting entity, and a sheet that stopped asserting a group

Both packs printed through `GET /api/accounting/packs/board/pdf?from=2026-01-01&to=2026-09-07`
(never `scripts/pdf/render-pack.ts`), from a dedicated detached worktree at `cdcf17db` with an
empty `git status`, on its own dev server. See `provenance.txt`.

12 sheets, A4 portrait (595.92 x 842.88 pt), both companies. **No omission footnote on any of
the 24 sheets** (`grep -c "Not printed on this page"` = 0 on both text extracts).

## E1 — criterion 11, both halves

### The word "group" is gone from both documents

    grep -niE 'g *r *o *u *p' t-demo.txt t-brightsphere.txt   ->  no match

(the spaced pattern is needed because the running page header is letter-spaced). Sheet 5's
header now reads `M O N T H LY R E S U LT S` on both packs and the contents line reads
`5 Monthly results`. The sheet is a month-by-month table of one entity's results — one row per
trend month — so the name asserts nothing the pack does not print.

### Page 12 names the reporting entity and states the basis

Demo, sheet 12, as printed:

    Standard and currency IFRS for SMEs. ZAR in R'000.        Source system IsaFlow general ledger
    Reporting entity ISAFlow Demo (Pty) Ltd alone. These      Rounding Components may not add exactly to the totals
    figures are not consolidated.                             shown. A ratio taken on the unrounded figures may not
    Period 1 January 2026 to 7 September 2026. The series     reproduce from the rounded ones beside it.
    ends on a part month: Sep 2026 covers 7 of its 30 days.   Extracted at 8 September 2026 at 17:21 SAST
    Comparative period 26 April 2025 to 31 December 2025      Ledger version 7 September 2026 at 17:45 SAST

Brightsphere prints the same block with
`Reporting entity Brightsphere Technologies (Pty) Ltd alone. These figures are not consolidated.`

### What the entity statement cost page 12: nothing

Measured in vitest off `remainingPageMm` on the last page of six fixtures, before and after:

| fixture | before | after |
|---|---|---|
| demo | 8.64mm | 8.64mm |
| brightsphere | 9.31mm | 9.31mm |
| dense | 8.64mm | 8.64mm |
| no ratio panels | 12.71mm | 12.71mm |
| live | 12.71mm | 12.71mm |
| live, with the EBITDA bridge that rounds | **2.59mm** | **2.59mm** |

Identical to the hundredth of a millimetre, because the fact was paid for in restatement:

1. `Standard` ("IFRS for SMEs", 11 characters) and `Currency and rounding`
   ("ZAR, figures in R'000.", 22) were two one-line facts each leaving two thirds of an 83mm
   column white. They are one note, `Standard and currency`, carrying both verbatim — one line
   saved.
2. `ROUNDING_NOTE` opened "Figures are rounded to the nearest R'000, so …" under a fact that
   now states the scale two rows above it. That clause is gone from page 12 and the note is
   three lines rather than four — one line saved. The statement-page FOOTNOTE
   (`ROUNDING_COMPONENTS_NOTE`) is unchanged: it prints alone on a sheet and has to name the
   scale to stand up. Both are built from one `COMPONENTS_CLAUSE`, so they still cannot say
   different things about how this pack rounds.
3. `Reporting entity` is two lines. Net: zero, on every fixture.

The `Rounding` note keeps BOTH halves of the convention, including the ratio clause. All eight
basis facts print on all six fixtures (`packBasisMetadataKept.test.ts`, headings asserted by
name, not by count).

## E2 — the 4.44:1 finding does not reproduce; the colours did not move

The gate reported Brightsphere p6's `(5 535)` bar label at **4.44:1**, 0.06 under AA. Off the
v53 vector, the same content stream the gate read:

    fill  .1804 .6157 .3882   = #2e9d63
    label .0824 .1255 .1686   = #15202b

WCAG 2.1 relative luminances are 0.256069 and 0.013666, so the ratio is
`(0.256069 + 0.05) / (0.013666 + 0.05)` = **4.807:1** — above the 4.5 floor. The gate's own
white-on-green figure of 3.43:1 reproduces exactly (3.432), so the arithmetic went wrong on the
dark ink alone. Darkening the green would have bought nothing and would have closed the
greyscale separation page 12 claims, so `PRINT_FAV` is unchanged at `#2e9d63`.

What WAS real: nothing measured it. `packInkContrast.test.ts` held every ink the pack sets type
in against the PAPER, and a label set INSIDE a bar sits on a chart colour. `labelInkOn` is now
exported and the pair it returns is asserted at 4.5:1 on all three bar fills, with a mirror test
that it picks the better of the two inks and a greyscale-separation test beside it.

    income bar   #15202b on #2e9d63   4.81:1   (white would be 3.43:1)
    cost bar     #ffffff on #8c2f2f   7.68:1
    subtotal bar #ffffff on #15202b  17.40:1

Mutation-proved: setting `PRINT_FAV` to `#268755` (ink 3.68:1, paper 4.49:1 — both under) turns
the income-bar assertion red. `#1f7a4d` and `#3fae74` stay green and correctly so: the label
flips to paper at 5.32:1 and 4.67:1, which is the rule working.

## Type and grid, unchanged

`pdffonts`, identical on both files — four subsets, one family, no fallback face:

    AAAAAA+IBMPlexSans        BAAAAA+IBMPlexSans-SmBld
    CAAAAA+IBMPlexSans        DAAAAA+IBMPlexSans-Medm

## Files
`board-demo.pdf`, `board-brightsphere.pdf`, `png-demo/p-01..12.png`, `png-bs/p-01..12.png`,
`t-demo.txt`, `t-brightsphere.txt`.
