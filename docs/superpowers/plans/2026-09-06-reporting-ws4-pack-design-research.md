# WS4 — Pack design: research brief and target specification

Date: 2026-09-06. Branch: `plan/reporting-ws4-pack-design`. Status: research + target spec, not an
implementation plan. Nothing here is committed to a sprint until §8 is answered by the owner.

**The problem this brief exists to solve.** The current board pack
(`/home/hein/Downloads/report-pack-board-2025-12-31-to-2026-09-06.pdf`, 7 pages, read in full) is
rejected. Concretely, page by page: the cover is four centred lines of Times-like serif on an
otherwise empty A4; the contents page lists five items and then 80% white space; the income
statement has **one** column headed `ACTUAL` with no comparative of any kind; the balance sheet
shows `Total Assets (3 699 319.78)` — a negative asset total printed without a word of
explanation; the ratios page dumps **40 raw ratios** in a three-column grid with no grouping, no
target, no trend, and five of them replaced by the same 14-word sentence about negative equity;
the KPI scorecard shows five tiles in a six-tile grid and stops; the commentary page is **one
sentence**. Zero charts across seven pages. The pack is a data dump with a cover.

The machinery to do far better already exists and is largely unused by this output: an ECharts
IBCS chart kit with a working custom-series waterfall, bullet rows, small multiples and a Sankey;
statement comparators; a Chromium print pipeline with two interchangeable transports; native
pptx export with real chart objects; an approved-commentary workflow with a live Claude
integration behind it; share links; and a `brand_profiles` table. WS4 is a design and assembly
problem, not a rendering-capability problem.

Four research streams feed this brief and are cited throughout rather than repeated:

| Stream | File | What it covers |
|---|---|---|
| Market | `research-packs/market.md` | 25 SME/accountant reporting products, 9 sample PDFs read |
| Enterprise | `research-packs/enterprise.md` | CPM tier, IBCS/Few/Minto, 6 reference PDFs read |
| Corporate | `research-packs/corporate.md` | JSE results booklets, IFRS for SMEs, SENS/press rules |
| Tech | `research-packs/tech.md` | What this stack can render, with file:line evidence |

Scratchpad root for all sample PDFs:
`/tmp/claude-1003/-home-hein-Workspace-IsaFlow/6c715a27-dc13-46f9-9720-6f20cc78edf5/scratchpad/research-packs/`.
Sample PDFs are **not** copied into the repo. URLs are given where a reference is public.

---

## 1. What the market ships

### 1.1 The comparison

Density is expressed as approximate page fill. "Comparatives" is what a *typical* numbers page
shows, not what the product can be configured to show.

| Product | Page sequence | Charts / page | Comparatives | Commentary | Deck export | Branding | Density | Price signal |
|---|---|---|---|---|---|---|---|---|
| **Fathom** | Cover → confidentiality page → Notes to Management (prose + action items + 3 stat tiles) → client/project analysis → revenue & expenses → full P&L (2pp) → KPI radial scorecard → breakeven → cash-flow waterfall → 12-mo forecast → Gantt roadmap | 2–4 | Prior month, prior year, budget, rolling 12-mo forecast, best/worst case | Hand-written exec summary **plus** static ratio-definition boilerplate identical across unrelated companies | Claimed PPTX/Slides as a paid add-on; not in any sample | Logo on cover only; one accent colour threaded through charts | 55–65% | ~$65–70/mo entry, ~$680/mo multi-entity; priced by entity count, all features bundled |
| **Reach Reporting** | Cover → TOC with page numbers → 4–6 dense topical pages (Sales Performance, Cost Analysis, Financial Health, Equity) → section divider → full P&L / BS / CF | **3–5** | **3-period trailing on every table** (actual / prior year / 2 years ago) | Auto-sentence per metric with the delta colour-coded inline; formulaic but denser than Fathom | Not confirmed | `YOUR COMPANY LOGO HERE` on **every** page | 75–85% | Template-gallery model; positioned against Fathom/Spotlight |
| **Fathom-in-QuickBooks** ("Smart Reporting") | Identical Fathom engine, QuickBooks reskin | 2–4 | Same as Fathom | Same as Fathom | Not shown | QBO cover art, not the advisor's; grey "Prepared by Advisor Co" footer | 55–65% | Bundled free with QBO Advanced |
| **Spotlight Reporting** | 4 sample packs exist, gated behind a lead form; contents unverified | ? | ? | ? | Not confirmed | Manual image/PDF paste-in, no theme engine | ? | From $35/mo; advisor tier from $295/mo |
| **Syft Analytics** | Self-assembled: configurable P&L/BS/CF views plus a separate dashboard builder | ? | Prior period, prior-year-same-period, budget, forecast | Opt-in AI assist, not a default narrative | PDF/Word/Excel; **no PPT** | Unknown | ? | $23–$95/mo single entity; $125–$799/mo unlimited |
| **Jirav** | User-built "Report Packages" mixing tables, free-text blocks and dashboard tiles; no fixed sequence | ? | Budget vs actual, scenario what-if | Collaborative in-line commentary, not generated | PDF, Excel/Sheets; no PPT found | Custom periods, colours, headers/footers | ? | Not public |
| **Joiin** | "Branded board packs" — P&L, BS, CF, KPIs, commentary; multi-entity consolidation specialist | ? | Multi-currency, intercompany eliminations | AI insights claimed | PDF/Excel, scheduled delivery | Claimed | ? | Not captured |
| **Brixx** | Forecast-first: dashboard → cash flow → P&L → BS → tax summary | 1–2 | Best/base/worst case, actuals vs forecast | None found | PDF "for board presentations", **PNG for slides** (images, not objects) | Not detailed | ? | Sage-owned |
| **Clockwork** | Explicitly anti-template; live dashboard, PDF snapshot | Custom | Variance / budget vs actual | None found | PDF; no PPT | Not detailed | ? | Not captured |
| **Xero native Report Packs** | Bound set of native reports with an orderable cover | 0–1 | Prior period / prior year per report | None | PDF | Org logo on cover | Low | **Free in every Xero tier — the floor** |
| **QuickBooks Advanced native** | Native reports are Excel-style grids; the actual "pack" is Fathom's | — | — | — | — | — | — | Bundled |
| **Sage Intelligence / Sage Pastel Intelligence** | Excel workbook templates linked to the ledger; output is a spreadsheet | ~0 | Month / YTD / budget columns | None | Excel only | Sage-blue header banding | Grid | ERP module add-on |
| **LiveFlow / G-Accon** | Spreadsheet-native, auto-refreshed from Xero/QBO; tabs not pages | 0 | YoY, MoM, budget vs actual (LiveFlow); configurable trailing periods (G-Accon) | None | None — Sheets/Excel is the product | Font/colour/border per section (G-Accon) | Grid | Not captured |
| **Numeric** | Close-management, not a pack tool; "flux analysis" narrative | ? | Prior period flux | AI variance narrative implied | ? | ? | ? | Not captured |
| **Digits / Puzzle / Bench / Pilot** | Portal-first, "not static PDFs"; three core statements, interactive | ? | ? | Claimed industry-specific commentary (Pilot); human-written (Bench) | Portal-native; PDF export claimed | ? | ? | Bundled into bookkeeping service |
| **Draftworx (SA)** | Statutory AFS only: cover → index → directors' responsibility → directors' report → auditor's report → SOFP → SOCI → SOCE → SOCF → policies → notes → detailed income statement | **0** | Current vs prior statutory columns | None — legal language only | N/A | Company/registration header, IFRS-for-SMEs formatting | Text | Per SA practice seat |
| **CaseWare Africa** | Audit working papers + linked AFS, iXBRL/CIPC pre-tagging | — | — | — | — | — | — | Not public |

Two structural findings from the table matter more than any single row.

**Nobody in the SME tier ships a native deck.** Not Fathom, not Reach, not Spotlight, not Syft,
not Jirav, not Clockwork. Brixx exports PNGs for slides, which is a picture of a chart, not a
chart. Native PowerPoint with live chart objects appears only in the enterprise FP&A tier (Cube,
Vena, Datarails, whose entire pitch is "no more copy-paste"). IsaFlow already has
`pptxExportService.ts` emitting real `pptx.addChart` objects with their own data sheets. That is
a genuine differentiator against the whole SME field and it is already built.

**Almost nobody publishes a sample.** Seventeen of the products above have no sample PDF a
prospect can download without a trial account or a lead form. Fathom and Reach are the outliers.
A public, no-signup "see a real pack" page is a cheap differentiator and it is also, usefully, the
forcing function that makes the pack good — you cannot publish what you are embarrassed by.

### 1.2 The three strongest SME references

**1. Fathom** — `samples/fathom-lumin-digital.pdf` (14pp), `fathom-jartan-consolidated.pdf` (11pp),
`fathom-flippy-usd.pdf` (14pp). The only fully realised multi-page template engine in the tier.

- **p.3 "Notes to Management"** (read directly): two-column layout, hand-written prose in the wide
  column, an "Action Items" bullet panel in the narrow one, then a three-up row of key financial
  metrics — each a large number, a coloured up/down triangle with the delta and its basis ("▼ -17.3%
  from last month", "▲ 0.56% vs target"), an inline sparkline, and a definition paragraph. This one
  page is the template for our board pack's Highlights + Narrative pages.
- **p.9 KPI Analysis**: a radial scorecard clustering ~16 KPIs by importance with red/green
  pass-fail markers. The consolidated sample replaces it with a **lettered scored KPI table**
  (A. Profitability, B. Activity, C. Efficiency, D. Coverage, E. Gearing, F. Cash Flow, G. Growth)
  with Result / Target / Trend / Importance columns. That table is the direct answer to our
  forty-loose-ratios page.
- **p.11 Cash Flow waterfall**: a full indirect-method bridge with add/less items as real
  waterfall bars.
- **Consolidated sample, "Financials by Company"**: side-by-side P&L and BS columns per entity plus
  a Total. Copy directly if group consolidation ships.
- **Beat**: the wasted full-page confidentiality notice (make it a footer), the static ratio
  boilerplate that repeats verbatim across unrelated companies, the absent table of contents, and
  the 55–65% page fill.

**2. Reach Reporting** — `samples/reach-comprehensive-overview.pdf` (13pp) and three siblings.
Public template gallery with live PDF previews at
https://reachreporting.com/financial-templates — no signup.

- **p.1 "Sales Performance"** and **p.2 "Cost Analysis"** (read directly): a pale rounded header
  band carrying company name, period and section title, with the logo slot at top right. Then
  three stacked blocks per page, each a section heading over a table or chart in a wide left
  column and a **narrative sidebar** in a narrow right column. The sidebar has two parts: a
  generated variance sentence with a coloured arrow and the delta bolded inline ("Total Hardware
  Sales ($4.4m) were **18% higher (+$676.3k)** than Jan 2024 – Apr 2024"), then a grey "what to
  look for" paragraph. Every table carries three period columns: Actuals / Prior Yr / 2 Yrs Ago.
- Density is 75–85% fill with 3–5 elements per page and it still reads cleanly, because the
  left/right split is identical on every page.
- **Beat**: the commentary is a template sentence with numbers swapped in, and the grey
  "what to look for" paragraph is generic filler that would read identically for any company.

**3. Fathom-in-QuickBooks** — `samples/qbo-craig-design-monthly.pdf` (10pp). Ranked third for one
copyable detail: the footer is a small grey "Prepared by Advisor Co" plus a page number, and
nothing else. That is the cleanest attribution pattern in the entire scan and it is what our
footer should be. Its second value is strategic: QuickBooks did not build its own pack engine, it
licensed Fathom's — evidence that pack design is a real moat, not a weekend of CSS.

Pricing floor to clear: Xero's native Report Packs are free, bundled, chartless and
scoring-free. Every paid product in the table is selling design and interpretation, not data.

---

## 2. The design ceiling

Ten rules from the enterprise stream, each tied to a page in a named reference. All six reference
PDFs live in `research-packs/enterprise/`; the corporate references in `research-packs/corporate/`.

| # | Rule | Evidence |
|---|---|---|
| 1 | **The page title is the conclusion, not a label.** "LATAM is leading the way", not "Regional overview". | `naspers-hy2026-results.pdf` slides 3–10, every title. Same pattern in `vodacom-interim-presentation-2025.pdf` p.7: "Group results snapshot \| **Double-digit growth**" — a neutral label, a pipe, then the message in brand colour. Doctrine source: Minto's Pyramid Principle. |
| 2 | **Spend the design budget on the first 1–3 pages; leave the statutory statements plain.** | `shopify-q4-25-press-release.pdf`: pp.1–3 carry the headline, the summary table and the stat-tile page; pp.4–8 (Operations, Balance Sheet, Cash Flow, non-GAAP reconciliation) are plain black-on-white with light row banding and **no colour at all**. `workiva-2020-annual-report.pdf` does the same at book scale — magazine narrative front, unstyled 10-K stapled behind. |
| 3 | **One message per page.** | `naspers-hy2026-results.pdf` p.5: a map, a donut pair and a 2×2 tile grid all serving one claim about footprint. `jrh3-management-accounts-pack-sample.pdf` p.1 states it as a house rule: "Keep it simple. Make sure everyone in your leadership team understands every section of the pack." |
| 4 | **Colour is reserved for signal: variance sign and one brand accent. Never decoration.** | `shopify-q4-25-press-release.pdf` — a single dark-green left-edge bar is the only recurring brand device across nine pages. Zebra BI's IBCS case study states it outright: "colour should be reserved for more important things." |
| 5 | **One variance notation, applied on every page of the pack.** Solid = actual, outline = plan/budget, hatched = forecast, grey = prior year. | IBCS SUCCESS "Unify"; Zebra BI is IBCS-certified (2015, recertified 2020) and no SME tool in §1 is. Our `src/components/accounting/charts/ibcs.ts` `roleStyle()` already encodes this. |
| 6 | **Numbered structural walkthroughs (1→5) reused as a grammar across the pack**, not just on the summary page. | `naspers-hy2026-results.pdf` slides 3–4: numbered-circle five-point summary, with the circle colours reused per business line for the rest of the deck. |
| 7 | **Big-number stat tiles with a one-line multi-year trend footnote** when the point is "how good is this number", not "how did it move". | `shopify-q4-25-press-release.pdf` p.2, read directly: "29% / GMV growth that scales with merchant success / (2024: 24%, 2023: 20%, 2022: 12%)". Twelve tiles, three thematic groups, one rule per group, no chart on the page. |
| 8 | **Position content by importance, not by a symmetric grid.** Upper-left is the most expensive space on the page and must never hold a legend or a logo. | `few-formatting-layout-matter.pdf` pp.1–4, failure modes 1, 2 and 4, each illustrated with a real competition dashboard. Few's "quadrant of emphasis" diagram is on p.2. |
| 9 | **Small multiples beat multi-series spaghetti** when comparing one metric across many entities. | Zebra BI IBCS redesign case study; IBCS "Condense". We already have `SmallMultiples.tsx` + `smallMultiplesOption.ts`. |
| 10 | **Separate the narrative pack from the statutory pack.** Do not make one visual language do both jobs. | `workiva-2020-annual-report.pdf`: shelf-panel narrative pages front, plain 10-K behind. `mtn-h1-2026-sens.pdf` binds commentary + presentation + appendices + data sheets into one PDF but keeps a persistent four-tab header so the reader always knows which register they are in. |

Two supporting rules from the corporate stream that belong here:

11. **A metric that appears twice must be identical twice.** Vodacom's slide 7 group snapshot is
    the source of every growth number that appears anywhere else in that 39-slide deck.
12. **Never show a non-IFRS or adjusted figure without a reconciliation adjacent to it or
    footnoted to where the reconciliation lives.** Microsoft's release pairs every non-GAAP number
    with a line-by-line GAAP bridge; the JSE requires it as a compliance paragraph.

### The three visual anchors

| Output | Anchor | Why |
|---|---|---|
| **Board pack** | `enterprise/naspers-hy2026-results.pdf` (Prosus/Naspers H1 FY26, 64 slides) | Action-title discipline, numbered narrative grammar, brand-colour-coded units repeated across dozens of pages without clutter. Secondary anchor for the numbers pages: `corporate/vodacom-interim-presentation-2025.pdf` p.7 (snapshot) and p.8 (three-panel composition with a Growth column beside each stacked-bar pair). |
| **Results deck / results front section** | `enterprise/shopify-q4-25-press-release.pdf` | The "one table + one stat-tile page + plain statutory statements" pattern, at nine pages, executed by a company with an unlimited design budget that chose restraint. |
| **Financial pack** | `enterprise/workiva-2020-annual-report.pdf` for the front/back structure; `corporate/pkf-ifrs-for-smes-illustrative.pdf` for the statutory core | Workiva shows how to bind a narrative front to an unstyled statutory back. PKF gives the exact IFRS-for-SMEs statement order, the note ordering, and a right-margin paragraph-reference column that is the model for our own figure-traceability audit trail. |

Contrast anchor — the floor, not the target: `enterprise/jrh3-management-accounts-pack-sample.pdf`.
Word-doc typography, one Excel-default chart per page, a flat red target line, no variance
notation. Our current pack output is **below** this floor because it has no charts at all.

---

## 3. Conventions that must hold, versus style

### 3.1 MUST — IBCS

Breaking these makes the pack non-compliant with a published standard, not merely less polished.
Source: `ibcs.com` SUCCESS formula (SAY, UNIFY, CONDENSE, CHECK, EXPRESS, SIMPLIFY, STRUCTURE).
The full 150-page IBCS 1.2 standards book is paywalled and was not accessed; notation details
below are from IBCS's published visual grammar and Zebra BI's certified implementation, and
should be treated as well-evidenced convention rather than verbatim quotation.

- **SAY** — every chart and table carries one message. The title states it.
- **UNIFY** — one semantic notation across the entire pack: solid dark fill = actual, hollow
  outline = plan/budget, hatched = forecast, solid grey = previous year. Same meaning on every
  page, every pack, every company.
- **Variance colour is semantic, not literal.** Red means unfavourable, not negative. On a cost
  line a *positive* variance is red. This is the single rule most often got wrong.
- **CONDENSE** — maximise information density, remove chart junk.
- **CHECK** — no truncated bar axes, no 3D, no visual proportion that misstates the number.
- **EXPRESS** — bar for comparison, line for trend, waterfall for a bridge. Never a pie for a trend.
- **SIMPLIFY** — no gridlines, no borders, no legend where direct labelling works. Vodacom's deck
  has no y-axis gridlines on any chart and labels every value directly.
- **STRUCTURE** — grouping, ordering and alignment carry meaning by themselves.
- **Number notation** — negatives in parentheses, right-aligned, never a leading minus. Scale and
  unit stated once in a column or table header, never repeated per cell.
- **Colour-blind safety** — supplement the favourable/unfavourable colour with a shape or pattern
  cue. `roleStyle()` already carries a `decal` field for the forecast pattern; it is not yet
  applied to fav/unfav.

### 3.2 MUST — IFRS for SMEs

- **Two comparative periods on every primary statement.** No exceptions. Our current pack fails
  this on both statements it prints.
- **Statement order**: statement of comprehensive income (and retained earnings, where the
  combined statement is permitted) → statement of financial position → statement of changes in
  equity → statement of cash flows → notes.
- **Current / non-current split** on both sides of the statement of financial position; the
  ordering choice (liquidity-first is the SA convention) stated once and applied consistently.
- **By nature or by function** — the income statement must state which basis it uses.
- **Cash flow** — three-category split (operating / investing / financing), method stated.
- **Notes order**: basis of preparation and accounting policies first (subdivided by topic), then
  estimates and judgements, then one note per primary-statement line item **in statement order**,
  ending with related parties, subsequent events, and the approval date.
- **Going concern** and any material uncertainty disclosed where relevant.
- **Every adjusted or normalised measure reconciles to its IFRS figure.**
- Entity name, period, presentation currency and rounding basis stated on every statement.

### 3.3 MUST — SA number formatting

Already correct in `src/lib/format/money.ts`; the requirement is to use it everywhere rather than
to change it.

- Space thousands separator, period decimal: `12 345.67`.
- Negatives in parentheses.
- Zero rendered as an en dash, not `0`.
- `R` prefix optional per context; scale (`R'000`, `Rm`) declared in the column header.
- Percentages to one decimal; ratios to two; days as integers.

### 3.4 MUST — JSE and press conventions, for press-facing output only

These bind only when the output is a public results announcement or is written to look like one.
For a private company's internal pack they are a *register* to imitate, not a rule to obey.

- **Masthead block**: full legal name, place of incorporation, registration number, and for a
  listed issuer ISIN / share code / ADR code. Observed identically in Vodacom's and Woolworths'
  announcements. For a private company, the analogue is legal name + registration number + period.
- **Headline states the event; the sub-headline states the proof point.** Apple: "Apple reports
  third quarter results" + record-setting sub-headline. Shopify: "Shopify's Standout 2025: The
  Launchpad for a New Era of Commerce in 2026" + "$11.6B in revenue, $2B in free cash flow and the
  launch of a $2B share repurchase program".
- **Highlights bullets OR an opening numeric paragraph — one, not both.** Vodacom uses 6–8 bullets
  with the metric bolded inline. Apple uses one paragraph carrying exactly four numbers. Doing
  both is redundant.
- **Summary table**: current | prior | %-change, at most four data columns, 6–10 rows. Vodacom
  splits it into "Group statutory performance measures" and "Group additional performance
  measures" with a coloured header row on each.
- **Pro-forma / non-IFRS disclosure paragraph** wherever a normalised measure appears.
- **Dividend declaration**, if any: the five-date table in fixed order — last day to trade
  cum-dividend, ex-dividend, record, payment, plus the dematerialisation blackout window.
- **Forward-looking statement boilerplate** for any forward-looking content.
- **Short-form disclaimer**: state that it is a summary and link to the full document.
- **Sponsor named** at the foot — a JSE Listings Requirement for listed issuers only.
- Listed-issuer releases go via SENS before or simultaneously with any other channel.

### 3.5 MUST — not-meaningful and negative-equity disclosure

No vendor precedent exists. None of the nine SME sample PDFs contains a single not-meaningful
case — their demo data is all healthy. Our own data is not: Velocity Fibre has negative equity of
R24.7m and the current pack prints five ratio tiles replaced by the same explanatory sentence and
a `Total Assets (3 699 319.78)` with no comment. This is therefore a place where we set the
convention rather than copy one.

- A ratio whose denominator is zero, negative, or sign-inverted is **never printed as a number**.
  It prints as an en dash with a superscript footnote marker.
- The explanation appears **once**, as a numbered footnote at the foot of the page, not repeated
  inside each affected tile.
- A negative total on a primary statement gets a footnote on the line itself stating the
  condition, not a silent parenthesis.
- Negative equity triggers a **mandatory disclosure block** in the pack — going-concern relevance,
  the driver, and the movement since the prior period. A board pack that shows negative equity
  without saying so is worse than one that omits the number.
- The scorecard omits, rather than blanks, a KPI it cannot rank; the count of omitted KPIs is
  footnoted.

### 3.6 Style — legitimately ours to choose

Woolworths and Vodacom both satisfy every MUST above and look nothing alike. What is free:

- Brand palette and its saturation (a single accent plus neutrals is near-universal, the accent
  itself is not).
- Pull-quote box (MTN) versus plain in-line attribution (Vodacom, Apple).
- Dense multi-page regulatory register (Vodacom) versus single long infographic (Woolworths).
- Persistent section-tab navigation chrome (MTN) versus none.
- Photography-led versus data-led covers and dividers.
- Portrait pack versus landscape deck for the same content.
- Whether the confidentiality mark is a page, a footer, or a watermark. (It should be a footer.)

---

## 4. Target specification, page by page

Notation for each page: **purpose** · **title pattern** · **figures** · **charts** · **narrative
source** · **density** · **orientation**.

Narrative sources are one of: **approved** (drawn from `commentaryService.ts`, human-approved
before it renders), **generated** (grounded Claude output, still passing through the approval
workflow), **derived** (deterministic sentence built from figures by code, no model), or **none**.

Density targets are page fill: **high** = 70–85%, **medium** = 55–70%, **low** = under 55%
(reserved for covers and dividers only).

### 4.A Board pack — 12 pages, portrait A4

The audience is a board that will read it in ten minutes and ask three questions. Every page must
survive being read alone.

| # | Page | Spec |
|---|---|---|
| 1 | **Cover** | Purpose: identify and mark confidentiality. Title: company legal name, then "Board Pack", then the period. Figures: none. Charts: none. Narrative: none. Furniture: brand colour band, logo, "Confidential — for board use", draft or final mark, preparation date and preparer. Density: low, deliberately. Portrait. |
| 2 | **Contents** | Purpose: navigation. Title: "Contents". Figures: none. A numbered list with page numbers, grouped into three labelled sections (Performance / Financials / Governance). A one-line "Basis of preparation" note at the foot: standard applied, period, currency, rounding, and whether the figures are draft or final. Density: low–medium. Portrait. |
| 3 | **Highlights** | Purpose: the whole period in one page. Title pattern: message title — "Revenue up 12% but the operating loss widened to R5.8m". Figures: 8 KPI tiles — revenue, gross margin, operating profit, net profit, cash, net debt or leverage, debtor days, and one owner-chosen operational KPI. Each tile: label, big current figure, delta versus prior period with its basis stated, and a one-line multi-year footnote (Shopify p.2 pattern). Charts: an inline sparkline per tile, 5+ periods, no axes. Narrative: derived one-liner per tile; the page title is approved. Density: high. Portrait. |
| 4 | **Narrative** | Purpose: the CEO's or accountant's read of the period. Title: message title. Figures: **none on this page** — Vodacom, MTN and Apple all keep prose pages number-free except for the figures quoted in the prose itself. Two columns: the commentary in the wide column, an "Action items / matters for the board" bullet panel in the narrow one (Fathom p.3). Narrative: approved, mandatory — the page does not render without an approved block. Density: medium. Portrait. |
| 5 | **Results snapshot** | Purpose: the one table every later number traces back to. Title: "Group results \| <message>". Figures: one table, columns **Actual | Prior | Change | %** and nothing else. Rows: revenue, gross profit, operating profit, EBITDA, net profit, and where applicable net debt / EBITDA. Below it, a row of five brand-coloured KPI tiles (Vodacom p.7 pattern). Charts: none — the table is the chart. Narrative: derived caption naming the largest single mover. Density: high. Portrait. |
| 6 | **Income statement** | Purpose: how the result was earned. Title: message title. Figures: condensed P&L, **Actual | Prior | Change | % | % of revenue** — six data columns is the ceiling. Charts: a revenue-to-net-profit **waterfall** using the existing custom-series renderer, IBCS notation, with the bridge bars summing exactly to the endpoints. Narrative: generated, two sentences on the two largest movers. Density: high. Portrait. |
| 7 | **Financial position** | Purpose: what the business is standing on. Title: message title; where equity is negative the title must say so. Figures: condensed statement of financial position, two periods, current/non-current split both sides. Charts: a stacked composition bar per period (assets, liabilities, equity) — Vodacom p.8 pattern with a Growth column beside the pair. Narrative: generated. **Mandatory negative-equity block if applicable** (§3.5). Density: high. Portrait. |
| 8 | **Cash** | Purpose: where the cash went. Title: message title. Figures: condensed cash flow, three categories, two periods, plus opening and closing cash. Charts: a cash-flow **waterfall** (Fathom p.11 pattern), and a 13-period closing-cash line beneath it. Narrative: generated. Density: high. Portrait. |
| 9 | **Scorecard** | Purpose: replace the forty-ratio dump with a judgement. Title: "Scorecard \| <n> of <m> targets met". Figures: a **lettered, grouped, scored table** (Fathom consolidated pattern) — A. Profitability, B. Liquidity, C. Efficiency, D. Gearing, E. Cash — each row: Metric, Actual, Target, Prior, Trend, Status. At most 5 rows per group, at most 20 rows total. Not-meaningful rows show an en dash and a footnote marker. Charts: a bullet row per metric using the existing `BudgetBulletRow.tsx`, ranked by absolute variance. Narrative: derived — "n of m targets met; the largest miss is X". Density: high. Portrait. |
| 10 | **Trends** | Purpose: direction, not level. Title: message title. Figures: none in table form. Charts: **small multiples**, 6 panels, 13 periods each, shared y-scale within a row, direct end-labelling, no legend. Panels: revenue, gross margin %, operating expenses, net profit, cash, debtor days. Narrative: derived caption naming the panel that turned. Density: high. **Landscape** — the one landscape page in the pack, via the existing named-page CSS. |
| 11 | **Matters for the board** | Purpose: the page a board pack exists for and no public reference contains. Title: "Matters requiring board attention". Figures: a table of items — issue, quantum, owner, movement since last meeting, decision required. Sources: covenant headroom, going-concern indicators, aged debtor concentration, unusual journals, unreconciled bank items, overdue statutory filings. Narrative: approved. Density: medium. Portrait. |
| 12 | **Basis and definitions** | Purpose: make every number auditable. Title: "Basis of preparation and definitions". Content: standard applied, period, currency, rounding, source system and extract timestamp, the ledger version the pack was rendered against, definitions of every non-IFRS measure used with its reconciliation, and the numbered footnotes referenced from earlier pages. Density: medium. Portrait. |

Optional pages 13–14 for a group: per-entity financials (Fathom consolidated pattern) and a
segment panel set. Keep the core at 12.

### 4.B Management pack — 18 pages, portrait A4

Everything in the board pack at pages 1–8, using the **identical** tile and table components
(IBCS Unify — never redesign the same KPI tile twice for one organisation), then:

| # | Page | Spec |
|---|---|---|
| 9–10 | **Income statement in full** | Purpose: line-item detail. Title: message title on p.9, "continued" on p.10. Figures: full P&L by nature or by function (stated), **Actual | Budget | Var | Prior | Var** columns, every revenue and expense account with a material balance. Repeating table header across the page break (`thead { display: table-header-group }`). Charts: none — this is a statement. Narrative: none. Density: high. Portrait. |
| 11 | **Statement of financial position in full** | Full line-item detail, two periods, current/non-current split. No chart. Density: high. Portrait. |
| 12 | **Cash flow in full** | Full indirect-method statement, method stated, two periods. Charts: none (the waterfall is on p.8). Density: high. Portrait. |
| 13 | **Budget variance** | Purpose: where we are off plan. Title: message title naming the largest variance. Figures: variance table, IBCS scenario notation — solid actual, hollow budget, hatched forecast, grey prior year — with a delta column coloured semantically. Charts: bullet rows ranked by absolute variance, top 12 only. Narrative: generated, three sentences on the three largest variances, each naming a driver. Density: high. Portrait. |
| 14 | **Revenue and margin analysis** | By customer, product or segment as configured. Table plus a Pareto bar. Narrative: generated. Density: high. Portrait. |
| 15 | **Cost analysis** | Opex by category, two periods plus budget. Table plus a horizontal bar ranked by absolute change (Reach p.2 pattern). Narrative: generated. Density: high. Portrait. |
| 16 | **Working capital** | Debtor days, creditor days, inventory turns, cash conversion cycle. Aged debtors and aged creditors summary tables with the top five exposures named. Charts: a 13-period line per metric as small multiples. Narrative: generated. Density: high. Portrait. |
| 17 | **Cash and covenants** | Facility headroom, covenant tests with pass/fail, 13-week cash forecast if one exists. Narrative: approved. Density: medium. Portrait. |
| 18 | **Basis, definitions and reconciliations** | As board pack p.12, plus the full reconciliation of every adjusted measure used anywhere in the pack. Density: high. Portrait. |

Pages 19–20 are optional appendices: cost-centre detail, capex schedule, payroll summary.

### 4.C Financial pack (IFRS for SMEs) — 24 pages, portrait A4

This is the one pack where MUST-IFRS dominates style. It follows
`corporate/pkf-ifrs-for-smes-illustrative.pdf` exactly. Design budget goes on pages 1–3 and
nowhere else (rule 2). **No charts anywhere in this pack** — Draftworx has zero charts and that is
correct, not a gap.

| # | Page | Spec |
|---|---|---|
| 1 | Cover | Legal name, registration number, "Annual Financial Statements", period, "Prepared under IFRS for SMEs", audit/review/compilation status. Density: low. |
| 2 | Contents | Statements by page number, then the numbered note list by page number, then appendices. |
| 3 | General information | Registered office, directors, company secretary, bankers, auditors or independent reviewer, nature of business, preparer and their professional designation. |
| 4 | Directors' responsibility statement | Prose. Approved narrative. Going-concern conclusion stated here. |
| 5 | Directors' report | Prose: review of operations, results, dividends, share capital, events after reporting date, going concern. Approved narrative; figures quoted must trace. |
| 6 | Independent auditor's / reviewer's / compilation report | Positioned immediately before the primary statements, per MTN's contents ordering. |
| 7 | Statement of comprehensive income | By function or by nature (stated). Two periods. Note references in a right-hand column. Plain, no colour. |
| 8 | Statement of financial position | Current/non-current both sides, two periods, note references. |
| 9 | Statement of changes in equity | Full movement grid, two comparative years. |
| 10 | Statement of cash flows | Indirect method (stated), three categories, two periods. |
| 11–22 | Notes 1–n | Note 1 accounting policies subdivided by topic; then estimates and judgements; then one note per primary-statement line item **in statement order**; ending with related parties, subsequent events, and the approval date. Each note carries a right-margin IFRS-for-SMEs paragraph reference — printed or held as an internal audit trail per §8 decision 5. |
| 23 | Detailed income statement | Unaudited supplementary schedule, marked as such (the Draftworx convention). |
| 24 | Basis, rounding and definitions | Currency, rounding, comparative restatements if any. |

The open question of whether this replaces or wraps the existing AFS module is §8 decision 2.

### 4.D Two-page results front section — press-release-ready, portrait A4

Combines the JSE short-form masthead-and-table convention with the US headline convention.
Reference: `enterprise/shopify-q4-25-press-release.pdf` pp.1–2 and
`corporate/vodacom-interim-sens-2025.pdf` p.1, both read directly.

**Page 1** — purpose: the entire result above the fold.

- Masthead: legal name, place of incorporation, registration number, period, release date. For a
  listed or listed-adjacent client, add ISIN and share code.
- **Headline**: a full sentence stating the event, set large. Not a label.
- **Sub-headline**: one line carrying the two or three numbers that matter.
- **Dateline paragraph**: place, date, entity, then exactly four numbers — revenue, a profit
  measure, a margin or per-share measure, and one growth rate. Nothing else.
- **Two quotes**: CEO first (strategic), CFO second (numeric). Plain attributed paragraphs, no
  pull-quote box. Approved narrative, mandatory.
- **Summary table**: "Selected performance information", columns **current | prior | change %**,
  6–10 rows, scale stated in the header. Where non-IFRS measures are used, split into two tables
  (statutory / additional) per the Vodacom pattern, with a superscript footnote to the
  reconciliation.
- Footnote line: definitions and reconciliation pointer.
- Density: high. One accent device only — a left-edge brand bar (Shopify) or a coloured table
  header row (Vodacom). Pick one at brand-profile level.

**Page 2** — purpose: proof and compliance.

- **Stat-tile block**: 8–12 tiles in 2–3 thematic groups, each with a rule above the group, a big
  number, a short caption, and a multi-year trend footnote. This is the Shopify p.2 page and it is
  the single most copyable page in the entire research set.
- **Outlook**: bullets, if the client provides them. Approved narrative.
- **Dividend/distribution declaration** with the five-date table, if applicable.
- **Forward-looking statement** boilerplate.
- **Closing block**: "this is a summary", link to the full pack, contacts, preparer, and sponsor
  where applicable.
- Density: high.

### 4.E Results deck — 16 slides, landscape 16:9, native pptx

Rendered through `pptxExportService.ts` with native chart objects where the chart type is
supported and PNG-at-2x pictures where it is not (waterfalls, sparklines, bullets, Sankey — see
§6). Anchor: `enterprise/naspers-hy2026-results.pdf` and
`corporate/vodacom-interim-presentation-2025.pdf`.

| # | Slide | Spec |
|---|---|---|
| 1 | Title | Full-bleed brand colour, company name, "Results presentation", period. Logo top-right, repeated on every slide thereafter. |
| 2 | Disclaimer | Always slide 2, never later (Vodacom convention). Basis of preparation, non-IFRS caveat, forward-looking caveat. |
| 3 | Agenda | Numbered 1–5, with the same numbered-circle grammar reused on slides 6, 9, 12, 15 (rule 6). |
| 4 | Highlights | Action title. Five to eight KPI tiles, native shapes, delta under each. |
| 5 | Results snapshot | Action title. The Vodacom p.7 table: metric header row, "Reported" and "Normalised" growth rows beneath, then five brand tiles below. Native table. |
| 6 | Revenue | Action title. Native bar chart, actual versus prior, with a growth column beside it. |
| 7 | Profit bridge | Action title. Waterfall as a **PNG picture** from the SSR renderer — correctness beats editability here. |
| 8 | Margin | Action title. Native combo: bars for gross profit, line for margin %. |
| 9 | Cost | Action title. Native horizontal bar ranked by absolute change. |
| 10 | Cash | Action title. Waterfall PNG plus a native line for closing cash. |
| 11 | Financial position | Action title. Native stacked bars, two periods, with a growth panel. |
| 12 | Scorecard | Action title. Native table, grouped and lettered, status column. |
| 13 | Trends | Action title. Small multiples as a PNG grid. |
| 14 | Outlook | Action title. Bullets only. Approved narrative. |
| 15 | Matters and asks | Action title. Bullets. Approved narrative. Speaker notes carry the detail. |
| 16 | Appendix divider + reconciliations | Native table of every non-IFRS reconciliation. |

Every slide: action title, one message, brand master, logo, slide number, and speaker notes
carrying the narrative that is not on the slide.

---

## 5. Visual system

### 5.1 Grid

- A4 portrait, 210 × 297 mm. Margins 18 mm outer, 20 mm top, 22 mm bottom (the footer lives in the
  bottom margin, drawn by the transport, not by page content).
- **12-column grid**, 8 mm gutter. Content column widths in use: 12 (full), 8+4 (table plus
  narrative sidebar — the Reach pattern), 6+6, 4+4+4 (tile rows), 3+3+3+3 (four-up tiles).
- **Vertical rhythm**: 6 mm baseline unit. Every block height is a multiple of it.
- Landscape pages use the existing named-page CSS (`@page landscape-page { size: A4 landscape }`
  plus `page: landscape-page` on the container) — not the transport-level landscape flag, which
  would flip the whole document.
- 16:9 deck slides: 12-column grid, 0.4" margins, title zone fixed at the top 0.9".

### 5.2 Typography

**IBM Plex Sans for text, IBM Plex Mono for figures**, both self-hosted as `.woff2` under the app
origin.

- Justification: SIL Open Font Licence; both expose tabular figures; IBM Plex Mono reads
  genuinely well at 9–10pt in a statement column, which most monospace faces do not; one family in
  two optical registers keeps the brand from fragmenting; and self-hosting is not optional —
  Gotenberg's Chromium runs a host allow-list that blocks `fonts.googleapis.com`, so a CDN font
  would render correctly under the Playwright transport and silently fall back under Gotenberg.
  That class of bug survives review.
- Alternatives considered and rejected: Inter (already used by the AFS renderer's 'modern' pairing,
  but its default figures are proportional and it has no companion mono), Source Sans 3 (fine, no
  advantage), the current `ui-monospace, monospace` fallback (correct alignment for free, but reads
  as terminal output, not as an annual report).
- Where a proportional face carries figures, `font-variant-numeric: tabular-nums` is set
  explicitly. It is not automatic.
- **Scale** (print): page title 20pt/24, section heading 13pt/18, body 9.5pt/14, table body
  9pt/13, table header 8pt/12 uppercase with 0.06em tracking, footnote 7.5pt/11, KPI tile value
  28pt/30, stat-tile hero value 40pt/42.
- Deck: title 28pt, body 14pt, table 11pt, footnote 8pt. Deck fonts must be a widely-installed
  family because pptxgenjs does not embed font files and PowerPoint substitutes silently — set
  `fontFace` to Plex with a documented fallback, and do not let the deck's identity depend on it.

### 5.3 Colour

- **One brand colour** from `brand_profiles.primary_colour`, used for: the cover band, section
  divider bands, table header rows, and the accent rule under page titles. Nowhere else.
- **IBCS greys** carry the data: ink `#1a1a1a`, strong grey `#4a4a4a` (prior year fills), mid grey
  `#8a8a8a` (secondary text), rule grey `#d8d8d8`, tint `#f5f5f5` (zebra banding).
- **Variance colour only**: favourable green, unfavourable red, applied to deltas, arrows and
  variance bars. Never to a category, never to a heading, never decoratively. Semantic, not
  literal — an over-budget cost is red even though the number is positive.
- Both variance colours carry a **shape cue** as well: an up or down triangle in text, a decal
  pattern in fills. Colour alone fails for a deuteranopic reader.
- Scenario notation in charts: actual = solid ink, prior year = solid grey, budget = hollow outline,
  forecast = hatched decal.
- **Contrast validation at brand-profile save time**, not render time: reject or auto-darken a
  primary colour that cannot carry white text at 4.5:1. By render time there is no UI to warn
  against.
- `print-color-adjust: exact` with the `-webkit-` prefix on every coloured block, or every brand
  band prints washed out. This is missing today.

### 5.4 Page furniture

- **Header**: none on content pages. The page title does that job. Section dividers carry the
  section name only.
- **Footer**, drawn by the transport's own footer template (Chromium's `.pageNumber` /
  `.totalPages` classes — CSS `@bottom-center` margin boxes do not work in Chromium and would
  silently do nothing): left = `<Company> · <Pack> · <Period>`, centre = confidentiality mark,
  right = `n / m`. 7.5pt, mid grey, hairline rule above.
- **Confidentiality is a footer, not a page.** This is Fathom's clearest mistake.
- **Draft mark**: where the period is unlocked or the pack is unapproved, a 45° `DRAFT` watermark
  at 6% opacity plus the word DRAFT in the footer. A pack rendered against an unlocked period must
  never look final.
- **Cover**: brand band across the top third, logo, legal name, pack name, period, confidentiality,
  preparer, and the generation timestamp. `@page :first { margin: 0 }` for a full-bleed band.
- **Section dividers**: only in the financial pack and only where a section runs more than four
  pages. Brand band, section number, section name, nothing else.
- **Page numbering** runs continuously from the cover, which is page 1 of n.

### 5.5 Tables

- No vertical rules ever. Horizontal rules only: a 1pt rule under the header row, a hairline
  between groups, a 1pt rule above a total, and a double rule under a grand total.
- Zebra banding at `#f5f5f5` only where a table exceeds 12 rows.
- Numbers right-aligned in tabular figures; labels left-aligned; indentation carries hierarchy
  (two levels maximum).
- Column headers: uppercase, 8pt, tracked, with the scale and unit stated once.
- Totals in semibold, not bold; grand totals in bold.
- `break-inside: avoid` on rows, `display: table-header-group` on `thead` so headers repeat across
  a page break. The second is not currently in `styles/print.css`.

### 5.6 Charts

- SVG, inline, rendered by ECharts in the page Chromium is printing. Never a raster in a PDF.
- No gridlines, no chart border, no legend where direct labelling works. Every value labelled at
  its mark, following Vodacom.
- Titles are messages. Axis labels only where the axis is not obvious.
- Bar for comparison, line for trend, waterfall for a bridge, bullet for target attainment, small
  multiples for many entities. No pies except for a single composition-at-a-point-in-time slide,
  and never for a trend.
- Chart heights are grid multiples: 48 mm (inline), 72 mm (half page), 110 mm (full page).
- One chart per message. A page carries at most three.

### 5.7 Density

Board pack pages 3, 5–10 at high density (70–85% fill). Reach proves high density reads cleanly
when the layout is identical page to page; Fathom's 55–65% is the thing to beat, not to match.
Covers and dividers are the only pages permitted under 55%. **A page with a single sentence on it
does not ship.** Every content page must be either full or merged into its neighbour.

---

## 6. What the stack must gain

Drawn from `tech.md`, which read the actual code. Effort: **S** = under a day, **M** = 1–3 days,
**L** = a week or more.

| # | Capability | Why | Effort | Files |
|---|---|---|---|---|
| 1 | **Self-host IBM Plex Sans + Plex Mono as `.woff2`** | Gotenberg's Chromium runs a host allow-list; a Google Fonts `@import` is a third origin, is blocked, and falls back silently — correct under Playwright, wrong under Gotenberg. Same-origin fonts also remove a network hop per render. | S | `public/fonts/`, `styles/print.css`, `src/lib/charts/theme.ts` (`figFont`) |
| 2 | **`print-color-adjust: exact`** (with `-webkit-` prefix) | Brand bands, KPI tile fills and chart fills currently print washed out by Chromium's ink-saving default. | S | `styles/print.css` |
| 3 | **Per-section Chromium header/footer templates** | CSS `@bottom-*` margin boxes and `position: running()` are not implemented in Blink and would silently do nothing. Page numbers work today through the transports' shared `HEADER_HTML`/`FOOTER_HTML`. A per-section running header needs one render call per section, stitched with `pdf-lib`. Do **not** adopt Paged.js for this — it is a client-side layout engine bolted onto a pipeline that already solves the one thing needed, and it adds a script that can throw and leave `data-print-ready` unset until the 30s gate times out. | M | `src/lib/pdf/pdfTransport.ts`, `renderPagePdf.ts`, `transports/gotenbergTransport.ts`, new stitcher |
| 4 | **`thead { display: table-header-group }` for long tables** | Full P&L and note tables run past a page. The AFS WeasyPrint CSS already does this; the pack CSS does not. | S | `styles/print.css` |
| 5 | **`brand_profiles` into the pack print pipeline** | The AFS renderer already injects `primary_colour`/`secondary_colour`/`font_family` into a per-request `:root` style block. The pack pipeline's CSS is static and shared across all companies. Mirror the AFS approach. | M | `styles/print.css`, the `usePrintMode` hook, pack page components, `afsHtmlRendererService.buildCss` as the model |
| 6 | **WCAG contrast validation on brand-profile save** | No contrast check exists anywhere in the repo. A company can save `#f5f5f5` as its primary colour and produce an unreadable cover. Validate at write time; there is no UI at render time. | S–M | `brand_profiles` write path, migration `338_brand_profiles.sql` schema unchanged |
| 7 | **SVG charts in print, confirmed end to end** | Already proven: ECharts 6.1 `renderToSVGString()` under `ssr: true` runs in plain Node and reproduces the custom-series waterfall, because the option builders take a palette argument rather than reading `document`. Proof file: `research-packs/tech/` SSR output. Work remaining is wiring the pack pages to render server-side rather than waiting on client hydration. | M | `src/lib/charts/echarts.ts`, `src/components/accounting/charts/*`, pack page components |
| 8 | **PNG-at-2x chart pictures for pptx** | pptxgenjs 4.x has no native waterfall and no sparkline. The PowerPoint workaround is a stacked bar with a transparent base, which is the same construction this repo already documented as broken across zero. Render the SSR SVG, rasterise at 2x, place with `addImage`. SVG-in-pptx is an interoperability risk; PNG is safe. Losing editability on the waterfall is the right trade. | M | `src/modules/accounting/services/packs/pptxExportService.ts`, new rasteriser |
| 9 | **pptx slide masters from `brand_profiles`** | The service hardcodes four hex constants. `defineSlideMaster` with the brand colours and a logo image is the mechanism. | S–M | `pptxExportService.ts`, `packDeckModel` |
| 10 | **Rendered-pack cache keyed by (company, packParamsHash, ledgerVersion)** | `packParamsHash.ts` already canonicalises pack parameters. The generic report cache has a 2-minute TTL, which is wrong for a document re-downloaded across a month-end close. Cache the rendered buffer in document storage and invalidate on ledger version, not on a clock. Highest-leverage performance item; do this before any job queue. | M | `src/lib/cache-keys.ts`, `packParamsHash.ts`, `src/lib/documentStorage.ts`, new `renderedPackCache` |
| 11 | **Grounding guard for AI commentary** | `packAiSummaryService.ts` is already a real Claude integration with pre-computed figures in the prompt — not a template. The gap is that nothing verifies the numbers in the *output* trace to numbers in the *input*. Guard: pass figures as a structured labelled block; extract every number-like token from the response and check it exists exactly or within rounding in the input set; reject sentences introducing an unseen number; never let the model derive a percentage or ratio. Build this **before** tone presets — presets on an unguarded prompt just triple the ways to produce an ungrounded sentence. | M | new `services/commentary/groundedNarrative.ts`, `packAiSummaryService.ts`, under the existing `commentaryService.ts` approval state machine |
| 12 | **Tone presets (board / management / press)** | A suffix on the existing prompt template selecting audience register. Cheap, but strictly after #11. | S | `groundedNarrative.ts` |
| 13 | **PDF metadata, and PDF/A if required** | Gotenberg 8 supports `metadata`, `pdfa` and `pdfua` on the same endpoint; none are passed today. Playwright's `page.pdf()` supports none of them at all. A "every AFS pack is PDF/A" requirement would silently hold on only one of two transports. Either scope it to Gotenberg deliberately or add a second hop through `/forms/pdfengines/convert`. See §8 decision 5. | S (Gotenberg) / M (parity) | `src/lib/pdf/transports/gotenbergForm.ts` |
| 14 | **Not-meaningful and negative-equity rendering** | New shared components: a footnote-marker cell, a page-foot footnote list, and the negative-equity disclosure block. No vendor precedent exists (§3.5); we set it. | S–M | pack page components, `src/lib/format/money.ts` reused unchanged |
| 15 | **Figure provenance map** | Every rendered figure carries the service call and field it came from, held in a render-time map. Feeds the acceptance gate's figure-integrity check (§7) and, in the financial pack, the right-margin IFRS paragraph reference. | M | pack model builders, new `packFigureProvenance.ts` |

Explicitly **not** doing, with reasons: Paged.js (#3 above); Vega-Lite or Plotly (ECharts already
solves the one real gap, and its `custom` series is what makes the waterfall and bullet possible);
an async job queue (L effort against an unmeasured problem — build the cache first); consolidating
AFS's WeasyPrint pipeline onto Chromium (it would lose `string-set` running headers with nothing
gained).

---

## 7. Acceptance gate

Three parts. All three must pass before a pack ships to a client.

### 7.1 Blind visual review, page by page, against the named references

A fresh reviewer who has not seen this brief's reasoning receives: our rendered PDF, the named
reference PDF for that pack type, and the rubric below. No implementation notes, no rationale, no
session context. It scores every page.

| # | Criterion | Pass | Fail |
|---|---|---|---|
| 1 | Message titles | Every content page title states a conclusion about this period's numbers | Any page titled with a bare label ("Financial Ratios", "Commentary") |
| 2 | Comparatives | Every primary statement and every KPI shows at least one comparative period | Any figure printed alone |
| 3 | Density | No content page under 55% fill; no page carrying fewer than three content blocks | Any page with a single sentence, a single table, or visible bottom-half emptiness |
| 4 | Charts present | At least one chart on each of the results, position, cash and trends pages | A pack with zero charts, or a numbers page with no visual |
| 5 | Variance notation | One notation for actual/prior/budget/forecast, identical on every chart in the pack | Two charts in one pack using different fills for the same scenario |
| 6 | Semantic colour | Colour appears only as brand accent or variance sign | Colour used for a category, a heading, or decoration |
| 7 | Colour-blind safety | Every variance colour is accompanied by a shape or pattern cue | Colour is the only carrier of favourable/unfavourable |
| 8 | Number formatting | Space thousands, period decimal, negatives in parentheses, zero as en dash, scale in the header | Any mixed convention within one pack |
| 9 | Not-meaningful handling | Every unrankable ratio shows an en dash with one page-foot footnote | The same explanatory sentence repeated inside multiple tiles |
| 10 | Negative equity / going concern | Where present, disclosed in a dedicated block and named in the page title | A negative total printed without comment |
| 11 | IFRS statement order and splits | Statement order correct; current/non-current split present; basis stated | Any deviation |
| 12 | Reconciliation | Every adjusted or non-IFRS measure reconciles on the page or by footnote | An adjusted number with no bridge |
| 13 | Page furniture | Footer on every page with company, period, confidentiality and `n / m`; draft state visible when applicable | Missing page numbers, a full-page confidentiality notice, or a draft pack that looks final |
| 14 | Typographic consistency | One type scale across the pack; tabular figures in every numeric column | Mixed sizes for the same role, or proportional figures misaligning a column |
| 15 | Reference comparison | For each page, the reviewer names the corresponding reference page and states which is better and why | Any page the reviewer cannot map to a reference intent |

Scoring: 15 criteria, pass/fail each. **Ship threshold is 15/15** on the board pack and the
results front section, and 14/15 on the management and financial packs where criterion 4 does not
apply to the financial pack at all (it has no charts by design, and the reviewer marks it N/A).

### 7.2 Figure integrity

Automated, run on every rendered pack, failing the render rather than warning:

- Every figure on every page resolves to a service figure through the provenance map (#15 above).
  No figure is computed in a component.
- Every figure that appears twice in one pack is byte-identical, including its rounding.
- Every statement foots: assets equal liabilities plus equity; the waterfall bars sum to the
  endpoints; each subtotal equals its components; the cash flow reconciles opening to closing cash.
- Every percentage and ratio recomputes from its stated numerator and denominator.
- Every number in generated commentary appears in the figure set supplied to the model, exactly or
  within stated rounding. A sentence introducing a new number fails the render.
- Comparative periods are the periods claimed in the column header.
- The pack states the ledger version it was rendered against, and re-rendering at that version is
  byte-identical.

### 7.3 The Fortune 500 CFO question

A second fresh reviewer, given only the rendered PDF and the deck with no context at all, answers
one question in writing: **"Would a Fortune 500 CFO put their name on this and send it to their
board?"** — yes or no, with three specific reasons and the single change that would most improve
it. A "no" blocks the ship regardless of the rubric score. The reviewer must not be the author and
must not have seen the plan; the author cannot referee their own work.

---

## 8. Open decisions for the owner

Six, each with a recommendation and the evidence that would change it.

**1. Where do brand assets come from?**
Recommendation: `brand_profiles` as it stands — `logo_url`, `primary_colour`,
`secondary_colour`, `font_family`, `cover_style`, `report_footer_text` — with a WCAG contrast
check added at save time, and a sane IsaFlow-neutral default for every company that has not set
one. Do not build a logo upload or brand-extraction flow in WS4.
Changes it: if a majority of live companies have no brand profile row, the default matters more
than the injection and the ordering flips. Check the row count before committing.

**2. Does the financial pack replace or wrap the existing AFS module?**
Recommendation: **wrap**. The AFS module renders through WeasyPrint with real CSS Paged Media —
`string-set` running headers and `@bottom-*` margin boxes that Chromium has never implemented and
would silently drop. Rebuilding statutory AFS on the pack pipeline loses capability for no gain.
The financial pack becomes a wrapper that binds the AFS output behind a designed cover, contents
and directors' pages, following Workiva's front-narrative / plain-statutory-back structure.
Changes it: if the AFS module's output is materially wrong or unmaintained, wrapping a broken
document is worse than rebuilding. Audit the current AFS output first — the memory index records
that AFS had never worked in production before September 2026.

**3. How far does the press section go?**
Recommendation: **two pages, private-company register, no JSE compliance claims.** Emit the
masthead as legal name plus registration number, the headline and sub-headline, the four-number
dateline paragraph, the summary table, the stat-tile page, and the forward-looking boilerplate.
Do **not** emit a sponsor line, an ISIN, or anything that implies a SENS release; do not claim
Listings Requirements compliance. Ship it as "results announcement draft", clearly a draft.
Changes it: a real listed or listing-track client asking for a SENS-ready short form. That is a
compliance product with sponsor sign-off, not a design feature, and it is a separate workstream.

**4. Which model writes the commentary, and at what cost?**
Recommendation: keep `packAiSummaryService`'s existing Claude integration, move it to the current
Sonnet generation, and build the grounding guard before anything else. One call per pack section,
roughly 8–12 calls per pack, a few thousand tokens each — cents per pack, not a cost problem at
current volumes. Every output still passes through the existing approval workflow before it
renders.
Changes it: a measured pack volume where per-pack model cost becomes material, or evidence that
Sonnet's grounded output is rejected by approvers often enough to justify a larger model. Log
approval and rejection rates from day one.

**5. Is PDF/A required?**
Recommendation: **no, not in WS4**. Pass PDF metadata (title, author, subject) on the Gotenberg
path now, which is free. PDF/A works only on the Gotenberg transport; a stated requirement that
silently fails whenever an operator unsets `GOTENBERG_URL` is worse than no requirement.
Changes it: a client with an archival or regulatory retention obligation naming PDF/A. Then it is
a Gotenberg-only guarantee, enforced by refusing to render the financial pack on the Playwright
transport rather than by hoping.

**6. Density versus page count.**
Recommendation: **density**. Board pack 12 pages at 70–85% fill, not 20 pages at 55%. Reach proves
high density reads cleanly when the layout is identical page to page; Fathom's low fill is the
thing being beaten. A page that cannot be filled gets merged into its neighbour.
Changes it: blind-review feedback that our high-density pages read as cluttered. That is a
layout-consistency failure before it is a density failure, so fix the layout before adding pages.

---

## 9. Build shape

Five workstreams. Ordering is driven by what unblocks the acceptance gate earliest.

| # | Workstream | Contents | Depends on | Estimate |
|---|---|---|---|---|
| A | **Print foundation** | Self-hosted fonts, `print-color-adjust`, repeating table headers, the 12-column print grid, type scale, table rules, footer and draft-mark templates, `brand_profiles` injection, contrast validation on save | — | 1 week |
| B | **Page component library** | KPI tile, stat tile with trend footnote, statement table with comparatives, scorecard group table, narrative sidebar block, footnote marker and page-foot list, negative-equity block, section divider, cover | A | 1.5 weeks |
| C | **Chart integration** | Server-side SVG rendering wired into pack pages, IBCS scenario notation applied uniformly, decal cue for fav/unfav, waterfall on the results and cash pages, bullet rows on the scorecard, small multiples on the trends page, chart height tokens | A | 1 week |
| D | **Pack assembly** | The five outputs of §4 built from B and C; figure provenance map; figure-integrity checks; rendered-pack cache | B, C | 2 weeks |
| E | **Narrative and deck** | Grounding guard, section-by-section generation under the existing approval workflow, tone presets, pptx masters from `brand_profiles`, PNG rasteriser for waterfalls and small multiples, the 16-slide deck | D | 1.5 weeks |

Roughly **7 weeks** of sequential work; A and the early part of C are parallelisable, so 5–6 weeks
with two people. The acceptance gate (§7) runs at the end of D on the board pack, and again at the
end of E on everything. Do not defer the first blind review to the end.

**The highest-risk unknown is the grounding guard.** Everything else in this brief is layout work
against proven machinery: the print pipeline works, the charts render, the pptx export emits real
chart objects, the formatter is already correct. The commentary is the one place where the
difference between "plain" and "listed quality" is not a CSS problem. Fathom and Reach both ship
template sentences with numbers swapped in, and the enterprise tier does not publish a single
unedited AI narrative sample — which tells you the category has not solved it either. A guard that
verifies every number in the output traces to a number in the input is buildable and is the right
first move, but it constrains *arithmetic*, not *judgement*: it cannot stop a well-grounded
sentence that draws a wrong conclusion. The mitigation is that the human approval workflow already
exists and every generated block passes through it. The risk is that approvers reject often enough
that the feature is a net cost. Instrument approval and rejection rates from the first pack, and
treat a sustained high rejection rate as a signal to fall back to derived deterministic sentences
for the sections that keep failing.

A second, smaller risk worth naming: pages 4, 11 and the results front section require
**approved** narrative and will not render without it. That makes the pack dependent on a human
step for its most valuable pages. If that friction proves unacceptable in use, the fallback is to
render those pages with a visible "commentary pending approval" placeholder rather than to drop
the requirement — a board pack whose narrative was never read by a person is the failure mode this
whole workstream exists to avoid.
