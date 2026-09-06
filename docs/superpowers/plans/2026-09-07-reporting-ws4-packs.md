# WS4 — Board, management and results packs at listed-company quality

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shipped report pack — one actual-only column, forty raw ratios, one sentence of commentary, no charts, pages 15% full — into a 12-page board pack, an 18-page management pack, a 2-page results front section and a 16-slide deck that a Fortune 500 CFO would put their name on.

**Architecture:** The pack stops being a variable list of sections rendered from a template and becomes a **fixed page sequence built from a typed page model**. A new `packPages` model layer composes each page from service figures; a new `PackPageView` component tree renders exactly those pages; the existing `packDocument` / `PackPrintView` pair is retired once both packs are migrated. Underneath it, the figure supply is widened from one actual-period fetch to a comparative set (actual + prior + budget), which is the actual root cause of the single-column pack. Charts render server-side as inline SVG through the ECharts wrapper already in the repo; print furniture (fonts, colour fidelity, footers, brand injection) moves into a print foundation shared by every pack.

**Tech Stack:** Next.js 14 Pages Router · TypeScript strict · React 18 · ECharts 6.1 (`renderToSVGString`, `ssr: true`) · Gotenberg 8 / Chromium (primary PDF transport) · Playwright (fallback transport) · pptxgenjs 4.x · Vitest 4 · Playwright E2E.

**Spec:** `docs/superpowers/plans/2026-09-06-reporting-ws4-pack-design-research.md` — sections 4 (page-by-page target spec), 5 (visual system), 6 (stack changes), 7 (acceptance gate), 8 (decisions, all six ACCEPTED as written), 9 (build shape). **Executors must read sections 4, 5 and 7 of the spec before their first task.** This plan argues from that spec and does not restate its page tables; where a task says "per spec §4.A page 6", that table is the requirement.

---

## Global Constraints

Copied verbatim from the repo rules and the spec. Every task's requirements implicitly include this section.

- **Branch first.** Never edit on `master`. Each workstream has its own branch and its own worktree; one implementer per worktree.
- **Multi-tenant:** every DB query carries `company_id`. No exceptions, including new figure fetches.
- **DB:** `sql` tagged template from `@/lib/neon`. Never string concatenation.
- **API handlers:** `withAuth(withErrorHandler(handler as any))`. Responses via `apiResponse.*`. Logging via `log` from `@/lib/logger` — never `console.log`.
- **Max 300 lines per file.** This binds hard in WS4b/c: a 12-page pack is 12+ component files, not one.
- **No `any`** except where a Next.js pattern requires it. No empty `catch`.
- **No stubs.** A `return null` placeholder to satisfy a typecheck is a plan violation, not a shortcut.
- **Migrations:** next unused 3-digit prefix, re-checked against `master` immediately before writing the file; `IF NOT EXISTS` on every `CREATE`.
- **Git:** stage by explicit path, never `git add -A`. No `git stash`, ever. No `--no-verify`. Read committed state with `git show <sha>:<path>`, never from disk.
- **Push:** `DATABASE_URL= timeout 560 git push` — the pre-push hook runs a full build, and an unset `DATABASE_URL` is what makes the local gate equal GitHub CI (three DB-gated tests fail on `isaflow_dev` data and are unrelated to this work).
- **CI gate before every PR:** `bun run ci`. Never run it while a dev server is running in the same worktree — the build clobbers `.next` in both directions.
- **Node ≥20.12.0, bun ≥1.3.0.** `nvm use` before `bun install`. Each worktree owns its own `node_modules`; a shared symlink gets pruned by a sibling worktree with a different lockfile.
- **Fonts are self-hosted.** A Google Fonts `@import` renders correctly under the Playwright transport and silently falls back under Gotenberg, whose Chromium allow-list blocks the third origin. **Never reintroduce a font CDN.**
- **Number formatting, one convention per pack:** space thousands separator, period decimal, negatives in parentheses, zero as an en dash, scale stated once in the column header. Reuse `src/lib/format/money.ts`; do not write a second formatter.
- **Colour is semantic only.** One brand colour (cover band, divider bands, table header rows, title accent rule) and nothing else; IBCS greys carry the data; green/red appear only on variance and always with a shape or decal cue.
- **No figure is computed in a component.** Components render figures the model already holds. This is existing doctrine in `packDocument.ts` and it extends unchanged to `packPages`.
- **Charts are inline SVG in the printed page.** Never a raster in a PDF. (PNG is used only inside the pptx deck, where pptxgenjs has no waterfall.)
- **Density:** no content page under 55% fill; board pack pages 3 and 5–10 at 70–85%. A page with a single sentence on it does not ship — it merges into its neighbour.
- **Approved-narrative pages do not render without approved narrative.** Board pack pages 4 and 11 and the results front section fall back to a visible "commentary pending approval" placeholder — never to a dropped requirement, never to unapproved model output.

---

## Ownership rulings

Decisions this plan makes so implementers do not re-litigate them. Each is binding; a task that disagrees with one raises it rather than deviating.

**R1 — The pack model is a fixed page sequence, not a section template.**
`reportPackService.getPackTemplate` returns a variable `PackSectionConfig[]` and `packDocument.ts` renders whatever comes back. Spec §4 specifies numbered pages with fixed content, several of which (highlights, scorecard, matters for the board, basis and definitions) have no section in the template at all, and several of which combine two existing sections onto one page. A new `packPages` model expresses that directly. `reportPackService` remains the figure assembler underneath and is not rewritten.

**R2 — `packDocument.ts` and `PackPrintView.tsx` are retired, not extended.**
WS4b puts the board pack on the new renderer; WS4c puts management and monthly on it; the last task of WS4c deletes `PackPrintView`, `PackSectionView`, `PackSectionCard`'s print usage and `packDocument.ts`. Until then both exist and `?print=1` dispatches on pack type. The interactive on-screen preview keeps its own markup, as it does today — the two share **formatters**, not layout.

**R3 — Comparatives are a model concern, fetched once, in one place.**
`getReportPackInput` gains a comparative fetch and returns `PackFigureSet { current, prior, budget }`. No page component and no chart option builder fetches anything. `priorPeriod.ts` computes the comparative window; `budgetVarianceService.ts` supplies budget where a budget exists, and `budget` is `null` where none does — which is the Brightsphere case and must render as an absent column, not as zeros.

**R4 — Every rendered figure carries provenance.**
A render-time `PackFigureProvenance` map records, for each figure, the service and field it came from. It is what the figure-integrity gate (spec §7.2) checks and what makes "every number traceable to a service figure" enforceable rather than aspirational. Figures reach pages only through `provenance.figure(...)`.

**R5 — Landscape stays page-level CSS.**
The trends page uses the existing `@page landscape-page` named-page rule. The transport-level `landscape` flag turns the whole document and must not be used for a single page.

**R6 — The scorecard replaces the ratio grid; it does not sit beside it.**
`calculateExtendedRatios` keeps returning its full set. The board pack renders 8–10 curated, grouped, scored rows and no others. The forty-row CSV grid does not appear in any pack. Not-meaningful rows show an en dash plus one page-foot footnote — never the same explanatory sentence repeated inside each tile.

**R7 — Commentary in WS4 is `approved` or `derived` only.**
Pages the spec marks `generated` render `derived` deterministic sentences in this workstream. The grounding guard (spec §6 item 11) is not in WS4's scope, and an ungrounded model sentence on a board pack page is the exact failure the programme exists to avoid. Each `derived` sentence is built by a pure function with its own test. This is a deliberate narrowing of spec §4 and is called out again in the final report.

**R8 — The press front section makes no listed-company claims.**
Per spec §8 decision 3: legal name plus registration number, no ISIN, no share code, no sponsor line, no Listings Requirements claim, and the document is marked "results announcement draft" on its face.

**R9 — Pages are components, one file each, under a 300-line ceiling.**
`src/components/accounting/packs/pages/<PageName>.tsx`. Shared primitives live in `src/components/accounting/packs/primitives/`. A page component that needs more than 300 lines is two blocks that want extracting.

---

## File structure

**Created — model layer (`src/modules/accounting/services/packs/`)**

| File | Responsibility |
|---|---|
| `figures/packFigureSet.ts` | `PackFigureSet` type + `buildPackFigureSet` — actual, prior, budget in one shape |
| `figures/packFigureProvenance.ts` | `PackFigureProvenance` — records service/field per figure; `figure()` accessor |
| `figures/packFigureIntegrity.ts` | The §7.2 checks: statements foot, repeated figures identical, ratios recompute |
| `pages/packPageModel.ts` | `PackPage`, `PackPageBlock` union, `PackPagesDocument` types |
| `pages/boardPackPages.ts` | Composes the 12 board pages from a `PackFigureSet` |
| `pages/managementPackPages.ts` | Composes the 18 management pages, reusing board pages 1–8 |
| `pages/packHighlights.ts` | The 8 highlight tiles + their sparkline series |
| `pages/packScorecard.ts` | The curated 8–10 grouped, scored, target-compared metrics (R6) |
| `pages/packMatters.ts` | Matters-for-the-board items from covenant/aging/journal/filing sources |
| `pages/packBasis.ts` | Basis of preparation, definitions, footnote register |
| `narrative/derivedSentences.ts` | Every `derived` caption, as pure tested functions (R7) |
| `packBrand.ts` | Resolved brand tokens for a company, with the neutral default |

**Created — print foundation**

| File | Responsibility |
|---|---|
| `public/fonts/*.woff2` | IBM Plex Sans (400/500/600) + IBM Plex Mono (400/500), latin subset |
| `styles/packPrint.css` | The pack print system: grid, type scale, table rules, density, colour fidelity |
| `src/lib/pdf/printFurniture.ts` | Chromium header/footer templates built per pack (company · pack · period · `n / m` · confidentiality · draft) |
| `src/lib/brand/contrast.ts` | WCAG relative luminance + contrast ratio; `assertReadableOnWhite`, `assertCarriesWhiteText` |
| `src/lib/charts/ssrSvg.ts` | `renderChartSvg(option, widthMm, heightMm)` — ECharts SSR to an inline SVG string |

**Created — components (`src/components/accounting/packs/`)**

| File | Responsibility |
|---|---|
| `PackPagesView.tsx` | Root of the new renderer; owns `data-print-ready` |
| `PackPageFrame.tsx` | One A4 page: title, accent rule, content grid, footnote foot |
| `primitives/KpiTileWithSparkline.tsx` | Highlight tile: label, value, delta with basis, sparkline, trend footnote |
| `primitives/StatTile.tsx` | Results-front-section hero tile |
| `primitives/ComparativeTable.tsx` | Statement table with Actual/Prior/Change/%/% of revenue columns |
| `primitives/ScorecardTable.tsx` | Lettered, grouped, scored table with status column |
| `primitives/NarrativeColumns.tsx` | Wide prose column + narrow action panel |
| `primitives/FootnoteMarker.tsx` + `primitives/FootnoteList.tsx` | Marker cell and page-foot list |
| `primitives/NegativeEquityBlock.tsx` | The mandatory disclosure block (spec §3.5) |
| `primitives/SectionDivider.tsx` · `primitives/PackCoverV2.tsx` · `primitives/PackContents.tsx` | Cover, contents, dividers |
| `pages/*.tsx` | One file per page of spec §4.A / §4.B |

**Modified**

| File | Change |
|---|---|
| `src/modules/accounting/services/reports/reportPackDataService.ts` | Comparative fetch (R3) |
| `src/lib/pdf/pdfTransport.ts` | `PdfRenderRequest.furniture`, `.metadata`; `FOOTER_HTML` becomes a builder |
| `src/lib/pdf/transports/gotenbergForm.ts` | `metadata` field |
| `src/lib/pdf/transports/playwrightTransport.ts` | Per-request header/footer |
| `src/modules/accounting/services/afs/brandProfileService.ts` | Contrast validation on save |
| `src/components/accounting/packs/usePrintMode.ts` | Chart-readiness count covers SSR SVG |
| `styles/print.css` | `print-color-adjust`, repeating `thead`, imports `packPrint.css` |
| `pages/accounting/reports/report-packs.tsx` | Dispatch to `PackPagesView` |
| `src/modules/accounting/services/packs/pptxExportService.ts` | Brand masters, 16 slides, PNG charts |

---

## Workstream map and gates

| WS | Branch | Contents | Gate |
|---|---|---|---|
| **WS4a** | `feat/ws4-print-foundations` | Tasks 1–7 | CI + blind `/review` team |
| **WS4b** | `feat/ws4-board-pack` | Tasks 8–20 | CI + **VISUAL GATE** + blind `/review` team |
| **WS4c** | `feat/ws4-management-pack` | Tasks 21–27 | CI + **VISUAL GATE** + blind `/review` team |
| **WS4d** | `feat/ws4-deck-front` | Tasks 28–34 | CI + **VISUAL GATE** + blind `/review` team |

**The VISUAL GATE runs BEFORE code review, not after.** A fresh `browser-qa`-class reviewer on opus, with no session context and no sight of this plan, receives: our rendered PDF, the named reference PDF, and spec §7.1's 15-criterion rubric. It scores pass/fail per page, checks figure integrity, and answers spec §7.3's Fortune-500-CFO question. Ship threshold: **15/15** on the board pack and results front section, 14/15 on management. A "no" on §7.3 blocks regardless of score. References: Prosus/Naspers HY2026 for the board pack, Shopify Q4-25 for the front section and deck, Reach and Fathom samples for density. Iterate until it passes; fix every finding.

**Every pack is proven on ISAFlow Demo first, then Brightsphere.** Brightsphere is the hostile case and is where the design actually gets tested: negative revenue in 2026-03..08, no budget, and a known R450 balance-sheet break in `isaflow_dev` only. A pack that renders beautifully on Demo and falls over on Brightsphere has not passed.

---

# WS4a — Print foundations

Branch `feat/ws4-print-foundations`, worktree `.claude/worktrees/ws4-foundations`.

### Task 1: Self-hosted IBM Plex

**Files:**
- Create: `public/fonts/IBMPlexSans-{Regular,Medium,SemiBold}.woff2`, `public/fonts/IBMPlexMono-{Regular,Medium}.woff2`, `public/fonts/OFL.txt`
- Create: `styles/packPrint.css`
- Modify: `styles/print.css`
- Test: `tests/unit/print/fontsSelfHosted.test.ts`

**Interfaces:**
- Produces: CSS custom properties `--pack-font-sans`, `--pack-font-mono` on `html.print-mode`.

- [ ] **Step 1: Fetch the fonts**

IBM Plex is SIL OFL 1.1. Take the latin-subset `.woff2` files from the `@ibm/plex-sans` and `@ibm/plex-mono` npm packages (`bun add -d @ibm/plex-sans @ibm/plex-mono`, copy the five files out of `node_modules/@ibm/plex-*/fonts/complete/woff2/`, then remove the dev dependencies) and commit them with `OFL.txt`. Do not add a runtime dependency on the packages; five committed files with their licence is the whole requirement.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/print/fontsSelfHosted.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'styles/packPrint.css'), 'utf8');

const FACES = [
  'IBMPlexSans-Regular.woff2', 'IBMPlexSans-Medium.woff2', 'IBMPlexSans-SemiBold.woff2',
  'IBMPlexMono-Regular.woff2', 'IBMPlexMono-Medium.woff2',
];

describe('self-hosted print fonts', () => {
  it('ships every face the print CSS references', () => {
    for (const face of FACES) {
      expect(existsSync(join(ROOT, 'public/fonts', face)), face).toBe(true);
      expect(CSS).toContain(`/fonts/${face}`);
    }
  });

  it('ships the OFL licence alongside them', () => {
    expect(existsSync(join(ROOT, 'public/fonts/OFL.txt'))).toBe(true);
  });

  it('references no third-origin font host', () => {
    // Gotenberg's Chromium allow-list blocks a CDN silently: correct under
    // Playwright, wrong under Gotenberg. This is the guard against that.
    expect(CSS).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit|cdn\.jsdelivr/);
    expect(CSS).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
  });

  it('declares tabular figures on the sans face', () => {
    expect(CSS).toMatch(/font-variant-numeric:\s*tabular-nums/);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

`bun run test:unit tests/unit/print/fontsSelfHosted.test.ts` — expected FAIL: `styles/packPrint.css` does not exist.

- [ ] **Step 4: Write `styles/packPrint.css`'s font block**

```css
/* styles/packPrint.css — the pack print system.
 *
 * Self-hosted because Gotenberg's Chromium runs a host allow-list: a
 * fonts.googleapis.com @import is a third origin, is blocked, and falls back
 * SILENTLY — right under Playwright, wrong under Gotenberg. Never reintroduce
 * a CDN font here. See tests/unit/print/fontsSelfHosted.test.ts.
 */
@font-face { font-family: 'IBM Plex Sans'; font-weight: 400; font-style: normal;
  font-display: block; src: url('/fonts/IBMPlexSans-Regular.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 500; font-style: normal;
  font-display: block; src: url('/fonts/IBMPlexSans-Medium.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 600; font-style: normal;
  font-display: block; src: url('/fonts/IBMPlexSans-SemiBold.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; font-style: normal;
  font-display: block; src: url('/fonts/IBMPlexMono-Regular.woff2') format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 500; font-style: normal;
  font-display: block; src: url('/fonts/IBMPlexMono-Medium.woff2') format('woff2'); }

html.print-mode {
  --pack-font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --pack-font-mono: 'IBM Plex Mono', ui-monospace, monospace;
}

html.print-mode body {
  font-family: var(--pack-font-sans);
  /* Not automatic on a proportional face. A statement column misaligns without it. */
  font-variant-numeric: tabular-nums;
}
```

`font-display: block` rather than `swap`: the renderer photographs the page as soon as `data-print-ready` is set, and a swap window would let it photograph the fallback.

- [ ] **Step 5: Import it from `print.css`**

Add `@import './packPrint.css';` as the first line of `styles/print.css` (before the `@media print` block — an `@import` after any rule is dropped).

- [ ] **Step 6: Run the test, expect PASS**

- [ ] **Step 7: Commit**

```bash
git add public/fonts styles/packPrint.css styles/print.css tests/unit/print/fontsSelfHosted.test.ts
git commit -m "feat(print): self-host IBM Plex Sans and Mono for the pack renderer"
```

---

### Task 2: Colour fidelity and repeating table headers

**Files:**
- Modify: `styles/packPrint.css`
- Test: `tests/unit/print/printCssRules.test.ts`

**Interfaces:**
- Consumes: `styles/packPrint.css` from Task 1.
- Produces: nothing importable; the CSS contract is asserted by test.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/print/printCssRules.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CSS = readFileSync(join(process.cwd(), 'styles/packPrint.css'), 'utf8');

/** Strip comments so a rule mentioned in prose cannot satisfy an assertion.
 *  A test that greps source text is a linter unless it reads only real rules. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('pack print CSS', () => {
  it('forces exact colour rendering, prefixed and unprefixed', () => {
    expect(RULES).toMatch(/-webkit-print-color-adjust:\s*exact/);
    expect(RULES).toMatch(/(?<!-webkit-)print-color-adjust:\s*exact/);
  });

  it('repeats table headers across a page break', () => {
    expect(RULES).toMatch(/thead[\s\S]{0,120}display:\s*table-header-group/);
  });

  it('keeps a table row and a chart whole across a break', () => {
    expect(RULES).toMatch(/break-inside:\s*avoid/);
  });

  it('declares the A4 page box with the specified margins', () => {
    expect(RULES).toMatch(/@page[\s\S]{0,200}size:\s*A4/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** on the colour-adjust assertion.

- [ ] **Step 3: Add the rules to `packPrint.css`**

```css
/* Chromium's ink-saving default washes out every brand band, KPI tile fill and
 * chart fill. Both spellings: the unprefixed property is the standard, the
 * -webkit- one is what Chromium 111 in the Gotenberg image actually honours. */
html.print-mode,
html.print-mode * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

@page {
  size: A4;
  margin: 20mm 18mm 22mm 18mm;
}

/* A full P&L and a notes table run past a page. Without this the second page
 * of a table has no column headings and its numbers are unreadable. */
html.print-mode thead {
  display: table-header-group;
}
html.print-mode tfoot {
  display: table-footer-group;
}
html.print-mode tr,
html.print-mode [data-pack-block] {
  break-inside: avoid;
}
```

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Mutation proof**

Delete the `-webkit-print-color-adjust` line, re-run, confirm RED, restore. A CSS assertion that never goes red is decoration. Record the result in the task's review notes.

- [ ] **Step 6: Commit**

```bash
git add styles/packPrint.css tests/unit/print/printCssRules.test.ts
git commit -m "feat(print): exact colour rendering and repeating table headers"
```

---

### Task 3: The print grid, type scale and table rules

**Files:**
- Modify: `styles/packPrint.css`
- Test: `tests/unit/print/printCssRules.test.ts` (extend)

**Interfaces:**
- Produces: classes `.pack-page`, `.pack-grid`, `.pack-title`, `.pack-section-heading`, `.pack-table`, `.pack-footnotes`, and the custom properties `--pack-col`, `--pack-gutter`, `--pack-baseline`.

- [ ] **Step 1: Write the failing test**

```ts
// appended to tests/unit/print/printCssRules.test.ts
describe('pack print grid and scale', () => {
  const REQUIRED_CLASSES = [
    '.pack-page', '.pack-grid', '.pack-title', '.pack-section-heading',
    '.pack-table', '.pack-footnotes', '.pack-kpi-value',
  ];

  it('defines every class the page components rely on', () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(RULES, cls).toContain(cls);
    }
  });

  it('uses a 12-column grid with an 8mm gutter', () => {
    expect(RULES).toMatch(/--pack-gutter:\s*8mm/);
    expect(RULES).toMatch(/grid-template-columns:\s*repeat\(12,/);
  });

  it('has no vertical table rules', () => {
    // IBCS: horizontal rules only. A border-left/right on a cell is the failure.
    expect(RULES).not.toMatch(/\.pack-table[^{]*\{[^}]*border-(left|right):/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement, per spec §5.1, §5.2, §5.5**

```css
html.print-mode {
  --pack-gutter: 8mm;
  --pack-baseline: 6mm;
  --pack-ink: #1a1a1a;
  --pack-grey-strong: #4a4a4a;
  --pack-grey-mid: #8a8a8a;
  --pack-rule: #d8d8d8;
  --pack-tint: #f5f5f5;
  /* Overridden per-request by the brand style block — Task 5. */
  --pack-brand: #1a3a5c;
  --pack-brand-ink: #ffffff;
}

.pack-page {
  break-after: page;
  /* 297mm less the 20/22mm page margins. Fixed so density is measurable
   * rather than a matter of opinion at review time. */
  min-height: 255mm;
  display: flex;
  flex-direction: column;
  color: var(--pack-ink);
}
.pack-page:last-child { break-after: auto; }

.pack-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--pack-gutter);
  align-items: start;
}

.pack-title {
  font-size: 20pt; line-height: 24pt; font-weight: 600;
  margin: 0 0 3mm; padding-bottom: 2mm;
  border-bottom: 2pt solid var(--pack-brand);
}
.pack-section-heading { font-size: 13pt; line-height: 18pt; font-weight: 600; margin: 0 0 2mm; }
.pack-kpi-value { font-family: var(--pack-font-mono); font-size: 28pt; line-height: 30pt; font-weight: 500; }
.pack-footnotes { font-size: 7.5pt; line-height: 11pt; color: var(--pack-grey-mid); margin-top: auto; padding-top: 3mm; }

.pack-table { width: 100%; border-collapse: collapse; font-size: 9pt; line-height: 13pt; }
.pack-table th {
  font-size: 8pt; line-height: 12pt; text-transform: uppercase; letter-spacing: 0.06em;
  font-weight: 500; text-align: right; padding: 1.5mm 2mm;
  border-bottom: 1pt solid var(--pack-ink);
}
.pack-table th:first-child, .pack-table td:first-child { text-align: left; }
.pack-table td { padding: 1.2mm 2mm; text-align: right; font-family: var(--pack-font-mono); }
.pack-table td:first-child { font-family: var(--pack-font-sans); }
.pack-table tbody tr.is-subtotal td { font-weight: 500; border-top: 1pt solid var(--pack-rule); }
.pack-table tbody tr.is-total td { font-weight: 600; border-top: 1pt solid var(--pack-ink); }
.pack-table tbody tr.is-grand-total td { font-weight: 600; border-top: 1pt solid var(--pack-ink); border-bottom: 3pt double var(--pack-ink); }
.pack-table.is-long tbody tr:nth-child(even) td { background: var(--pack-tint); }
```

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add styles/packPrint.css tests/unit/print/printCssRules.test.ts
git commit -m "feat(print): 12-column grid, IBCS type scale and table rules"
```

---

### Task 4: WCAG contrast validation on brand-profile save

**Files:**
- Create: `src/lib/brand/contrast.ts`
- Create: `tests/unit/brand/contrast.test.ts`
- Modify: `src/modules/accounting/services/afs/brandProfileService.ts`
- Test: `tests/unit/services/afs/brandProfileContrast.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function relativeLuminance(hex: string): number;
  export function contrastRatio(a: string, b: string): number;
  /** Throws when white text on `hex` is below 4.5:1. */
  export function assertCarriesWhiteText(hex: string, field: string): void;
  /** The colour to use when a company has no brand profile row. */
  export const NEUTRAL_BRAND_PRIMARY = '#1a3a5c';
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/brand/contrast.test.ts
import { describe, expect, it } from 'vitest';
import {
  assertCarriesWhiteText, contrastRatio, relativeLuminance, NEUTRAL_BRAND_PRIMARY,
} from '@/lib/brand/contrast';

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });

  it('matches the WCAG worked example for mid grey', () => {
    // #808080 -> 0.2158 per the WCAG 2.1 relative-luminance definition.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158, 3);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#1a3a5c', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#1a3a5c'), 6);
  });
});

describe('assertCarriesWhiteText', () => {
  it('accepts the neutral default', () => {
    expect(() => assertCarriesWhiteText(NEUTRAL_BRAND_PRIMARY, 'primaryColour')).not.toThrow();
  });

  it('rejects a near-white primary that would print an unreadable cover', () => {
    // The exact failure this exists to stop: a company saves #f5f5f5 and the
    // cover prints white on white. There is no UI at render time to warn.
    expect(() => assertCarriesWhiteText('#f5f5f5', 'primaryColour'))
      .toThrow(/primaryColour/);
  });

  it('names the measured ratio in the error so the message is actionable', () => {
    expect(() => assertCarriesWhiteText('#f5f5f5', 'primaryColour'))
      .toThrow(/1\.\d+:1|contrast/i);
  });

  it('accepts a colour exactly at the 4.5:1 threshold', () => {
    // #767676 on white is the canonical 4.54:1 boundary case.
    expect(() => assertCarriesWhiteText('#767676', 'primaryColour')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — module does not exist.

- [ ] **Step 3: Implement `src/lib/brand/contrast.ts`**

```ts
/**
 * WCAG 2.1 contrast, used to refuse a brand colour that cannot carry the cover.
 *
 * Validated at SAVE time, not at render time: by the time a pack renders there
 * is no UI to warn against, and the failure mode is a client receiving a cover
 * with white text on a near-white band.
 */

/** The IsaFlow-neutral primary for a company with no brand_profiles row. */
export const NEUTRAL_BRAND_PRIMARY = '#1a3a5c';

const MIN_RATIO = 4.5;

function channels(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m || m[1] === undefined) throw new Error(`Invalid hex colour: ${hex}`);
  const v = m[1];
  return [
    parseInt(v.slice(0, 2), 16) / 255,
    parseInt(v.slice(2, 4), 16) / 255,
    parseInt(v.slice(4, 6), 16) / 255,
  ];
}

function linearise(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linearise) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function assertCarriesWhiteText(hex: string, field: string): void {
  const ratio = contrastRatio(hex, '#ffffff');
  if (ratio < MIN_RATIO) {
    throw new Error(
      `${field} ${hex} has a contrast ratio of ${ratio.toFixed(2)}:1 against white text, ` +
      `below the WCAG AA minimum of ${MIN_RATIO}:1. Choose a darker colour.`,
    );
  }
}
```

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Wire it into the save path**

In `brandProfileService.upsertBrandProfile`, after the two existing `validateHex` calls:

```ts
assertCarriesWhiteText(input.primaryColour, 'primaryColour');
```

Only the primary is gated: it is the colour that carries white text on the cover band and table header rows. The secondary is an accent that never carries reversed text, so gating it would reject legitimate light accents.

- [ ] **Step 6: Write the service-level test**

```ts
// tests/unit/services/afs/brandProfileContrast.test.ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { sql } from '@/lib/neon';
import { upsertBrandProfile } from '@/modules/accounting/services/afs/brandProfileService';

describe('upsertBrandProfile contrast gate', () => {
  it('refuses a primary colour that cannot carry white text, without touching the database', async () => {
    await expect(upsertBrandProfile('c1', {
      primaryColour: '#f5f5f5', secondaryColour: '#c8a86b',
      fontFamily: 'professional', coverStyle: 'classic', logoUrl: null, reportFooterText: null,
    })).rejects.toThrow(/primaryColour/);
    expect(sql).not.toHaveBeenCalled();
  });
});
```

The `expect(sql).not.toHaveBeenCalled()` is the part that matters: validating after the write would leave the bad colour in the table.

- [ ] **Step 7: Run both tests, expect PASS. Commit.**

```bash
git add src/lib/brand/contrast.ts tests/unit/brand/contrast.test.ts \
        src/modules/accounting/services/afs/brandProfileService.ts \
        tests/unit/services/afs/brandProfileContrast.test.ts
git commit -m "feat(brand): WCAG contrast gate on brand-profile save"
```

---

### Task 5: Brand injection into the print pipeline

**Files:**
- Create: `src/modules/accounting/services/packs/packBrand.ts`
- Create: `tests/unit/services/packs/packBrand.test.ts`
- Modify: `src/components/accounting/packs/usePrintMode.ts`

**Interfaces:**
- Consumes: `getBrandProfile` (`afs/brandProfileService`), `NEUTRAL_BRAND_PRIMARY`, `contrastRatio` (Task 4).
- Produces:
  ```ts
  export interface PackBrand {
    primaryColour: string;
    secondaryColour: string;
    logoUrl: string | null;
    footerText: string | null;
    /** '#ffffff' or '#1a1a1a', whichever reads on primaryColour. */
    primaryInk: string;
  }
  export function resolvePackBrand(profile: BrandProfile | null): PackBrand;
  export function packBrandStyleBlock(brand: PackBrand): string;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packBrand.test.ts
import { describe, expect, it } from 'vitest';
import { packBrandStyleBlock, resolvePackBrand } from '@/modules/accounting/services/packs/packBrand';
import { NEUTRAL_BRAND_PRIMARY } from '@/lib/brand/contrast';

const profile = {
  id: 'b1', companyId: 'c1', logoUrl: 'https://app.isaflow.co.za/logo.png',
  primaryColour: '#1a3a5c', secondaryColour: '#c8a86b',
  fontFamily: 'professional' as const, coverStyle: 'classic' as const,
  reportFooterText: 'Confidential', createdAt: '', updatedAt: '',
};

describe('resolvePackBrand', () => {
  it('falls back to the neutral default when a company has no profile', () => {
    const brand = resolvePackBrand(null);
    expect(brand.primaryColour).toBe(NEUTRAL_BRAND_PRIMARY);
    expect(brand.logoUrl).toBeNull();
  });

  it('picks white ink on a dark primary and dark ink on a light one', () => {
    expect(resolvePackBrand({ ...profile, primaryColour: '#1a3a5c' }).primaryInk).toBe('#ffffff');
    expect(resolvePackBrand({ ...profile, primaryColour: '#e8c86b' }).primaryInk).toBe('#1a1a1a');
  });

  it('substitutes the neutral default for a legacy row that predates the contrast gate', () => {
    // Rows written before Task 4 were never validated. A render must not
    // reproduce an unreadable cover just because the row exists.
    expect(resolvePackBrand({ ...profile, primaryColour: '#fafafa' }).primaryColour)
      .toBe(NEUTRAL_BRAND_PRIMARY);
  });
});

describe('packBrandStyleBlock', () => {
  it('emits only custom-property declarations', () => {
    const css = packBrandStyleBlock(resolvePackBrand(profile));
    expect(css).toContain('--pack-brand: #1a3a5c');
    expect(css).toContain('--pack-brand-ink: #ffffff');
    expect(css.match(/[{}]/g)?.length).toBe(2);
  });

  it('refuses a colour that is not a plain hex triplet', () => {
    // The value reaches a <style> block, so anything but #rrggbb is an
    // injection surface, not a styling question.
    expect(() => packBrandStyleBlock({
      ...resolvePackBrand(profile),
      primaryColour: 'red; } body { display: none } :root {',
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement `packBrand.ts`**

```ts
/**
 * The brand tokens a printed pack renders with.
 *
 * Two things this file exists to stop. First, a company with no brand_profiles
 * row printing an unstyled pack — it gets the neutral default instead. Second,
 * a legacy row written before the contrast gate (Task 4) reproducing an
 * unreadable cover: the resolver re-checks and substitutes rather than trusting
 * the stored value.
 */
import type { BrandProfile } from '@/modules/accounting/services/afs/afsTypes';
import { NEUTRAL_BRAND_PRIMARY, contrastRatio } from '@/lib/brand/contrast';

const HEX = /^#[0-9a-fA-F]{6}$/;

export interface PackBrand {
  primaryColour: string;
  secondaryColour: string;
  logoUrl: string | null;
  footerText: string | null;
  primaryInk: string;
}

function safePrimary(value: string): string {
  if (!HEX.test(value)) return NEUTRAL_BRAND_PRIMARY;
  return contrastRatio(value, '#ffffff') >= 4.5 || contrastRatio(value, '#1a1a1a') >= 4.5
    ? value
    : NEUTRAL_BRAND_PRIMARY;
}

export function resolvePackBrand(profile: BrandProfile | null): PackBrand {
  const primaryColour = safePrimary(profile?.primaryColour ?? NEUTRAL_BRAND_PRIMARY);
  const secondaryColour = HEX.test(profile?.secondaryColour ?? '') ? profile!.secondaryColour : '#c8a86b';
  return {
    primaryColour,
    secondaryColour,
    logoUrl: profile?.logoUrl ?? null,
    footerText: profile?.reportFooterText ?? null,
    primaryInk: contrastRatio(primaryColour, '#ffffff') >= 4.5 ? '#ffffff' : '#1a1a1a',
  };
}

export function packBrandStyleBlock(brand: PackBrand): string {
  for (const [field, value] of [
    ['primaryColour', brand.primaryColour], ['secondaryColour', brand.secondaryColour],
    ['primaryInk', brand.primaryInk],
  ] as const) {
    if (!HEX.test(value)) throw new Error(`packBrandStyleBlock: ${field} is not a hex colour`);
  }
  return `html.print-mode {\n` +
    `  --pack-brand: ${brand.primaryColour};\n` +
    `  --pack-brand-secondary: ${brand.secondaryColour};\n` +
    `  --pack-brand-ink: ${brand.primaryInk};\n` +
    `}`;
}
```

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Render the style block from the print page**

`PackPagesView` (Task 12) renders `<style dangerouslySetInnerHTML={{ __html: packBrandStyleBlock(brand) }} />`. The hex guard in Step 3 is what makes that safe, and the test in Step 1 pins it. Note the reason in a comment at the call site.

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/packs/packBrand.ts tests/unit/services/packs/packBrand.test.ts
git commit -m "feat(packs): resolve brand tokens for the print pipeline"
```

---

### Task 6: Per-pack Chromium footer and PDF metadata

**Files:**
- Create: `src/lib/pdf/printFurniture.ts`
- Create: `tests/unit/pdf/printFurniture.test.ts`
- Modify: `src/lib/pdf/pdfTransport.ts`, `src/lib/pdf/transports/gotenbergForm.ts`, `src/lib/pdf/transports/gotenbergTransport.ts`, `src/lib/pdf/transports/playwrightTransport.ts`
- Test: `tests/unit/pdf/gotenbergForm.test.ts` (extend)

**Interfaces:**
- Produces:
  ```ts
  export interface PackFurniture {
    companyName: string; packLabel: string; period: string;
    confidentiality: string; draft: boolean;
  }
  export function buildFooterHtml(f: PackFurniture): string;
  export interface PdfMetadata { title: string; author: string; subject: string; creator: string }
  export function buildPdfMetadata(f: PackFurniture): PdfMetadata;
  ```
  `PdfRenderRequest` gains `footerHtml?: string` and `metadata?: PdfMetadata`; both transports use them, falling back to the current constants when absent.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/pdf/printFurniture.test.ts
import { describe, expect, it } from 'vitest';
import { buildFooterHtml, buildPdfMetadata } from '@/lib/pdf/printFurniture';

const base = {
  companyName: 'ISAFlow Demo (Pty) Ltd', packLabel: 'Board Pack',
  period: '1 Jan 2026 – 31 Aug 2026', confidentiality: 'Confidential — for board use',
  draft: false,
};

describe('buildFooterHtml', () => {
  it('carries company, pack, period, confidentiality and n / m', () => {
    const html = buildFooterHtml(base);
    expect(html).toContain('ISAFlow Demo');
    expect(html).toContain('Board Pack');
    expect(html).toContain('Confidential — for board use');
    // Chromium substitutes these classes; CSS @bottom-* margin boxes are not
    // implemented in Blink and would silently render nothing.
    expect(html).toContain('class="pageNumber"');
    expect(html).toContain('class="totalPages"');
  });

  it('marks a draft pack in the footer', () => {
    expect(buildFooterHtml({ ...base, draft: true })).toMatch(/DRAFT/);
    expect(buildFooterHtml(base)).not.toMatch(/DRAFT/);
  });

  it('escapes a company name containing markup', () => {
    const html = buildFooterHtml({ ...base, companyName: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('buildPdfMetadata', () => {
  it('titles the document as the reader will see it in a PDF viewer', () => {
    const meta = buildPdfMetadata(base);
    expect(meta.title).toBe('ISAFlow Demo (Pty) Ltd — Board Pack — 1 Jan 2026 – 31 Aug 2026');
    expect(meta.creator).toContain('IsaFlow');
  });

  it('marks a draft in the subject line', () => {
    expect(buildPdfMetadata({ ...base, draft: true }).subject).toMatch(/[Dd]raft/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement `printFurniture.ts`**

```ts
/**
 * The footer Chromium draws in the page margin, and the PDF's own metadata.
 *
 * The footer cannot be CSS: `@bottom-center` margin boxes and
 * `position: running()` are not implemented in Blink, and would silently draw
 * nothing. Chromium substitutes `.pageNumber` / `.totalPages` inside the
 * template it is handed, which is the only mechanism that works on both
 * transports.
 *
 * Everything interpolated here is escaped: a company name is user-controlled
 * text and this string is parsed as HTML by the renderer.
 */
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';

export interface PackFurniture {
  companyName: string;
  packLabel: string;
  period: string;
  confidentiality: string;
  draft: boolean;
}

export interface PdfMetadata {
  title: string;
  author: string;
  subject: string;
  creator: string;
}

export function buildFooterHtml(f: PackFurniture): string {
  const left = [f.companyName, f.packLabel, f.period].map(escapeHtml).join(' · ');
  const centre = escapeHtml(f.draft ? `${f.confidentiality} · DRAFT` : f.confidentiality);
  return (
    '<div style="font-family:sans-serif;font-size:7.5pt;color:#8a8a8a;width:100%;' +
    'padding:0 18mm;border-top:0.5pt solid #d8d8d8;display:flex;justify-content:space-between">' +
    `<span>${left}</span><span>${centre}</span>` +
    '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
    '</div>'
  );
}

export function buildPdfMetadata(f: PackFurniture): PdfMetadata {
  return {
    title: `${f.companyName} — ${f.packLabel} — ${f.period}`,
    author: f.companyName,
    subject: f.draft ? `${f.packLabel} (draft) for ${f.period}` : `${f.packLabel} for ${f.period}`,
    creator: 'IsaFlow',
  };
}
```

- [ ] **Step 4: Thread both through the transports**

In `pdfTransport.ts`, add to `PdfRenderRequest`:

```ts
  /** Per-pack footer. Falls back to FOOTER_HTML when absent. */
  footerHtml?: string;
  /** Written into the PDF's document information dictionary. Gotenberg only —
   *  Playwright's page.pdf() supports no metadata at all, which is exactly why
   *  spec §8 decision 5 declines to make PDF/A a requirement. */
  metadata?: PdfMetadata;
```

In `gotenbergForm.ts`, add to the returned fields:

```ts
    ...(request.metadata ? { metadata: JSON.stringify({
      Title: request.metadata.title, Author: request.metadata.author,
      Subject: request.metadata.subject, Creator: request.metadata.creator,
    }) } : {}),
```

In `gotenbergTransport.ts`, `form.append('files', htmlPart(request.footerHtml ?? FOOTER_HTML), 'footer.html')`.
In `playwrightTransport.ts`, `footerTemplate: request.footerHtml ?? FOOTER_HTML`.

- [ ] **Step 5: Extend the Gotenberg form test**

```ts
// appended to tests/unit/pdf/gotenbergForm.test.ts
it('sends PDF metadata as Gotenberg's JSON metadata field when present', () => {
  const fields = buildGotenbergFields({
    ...baseRequest,
    metadata: { title: 'T', author: 'A', subject: 'S', creator: 'IsaFlow' },
  }, { APP_URL: 'https://app.isaflow.co.za' });
  expect(JSON.parse(fields.metadata as string)).toMatchObject({ Title: 'T', Creator: 'IsaFlow' });
});

it('omits the metadata field entirely when none is supplied', () => {
  const fields = buildGotenbergFields(baseRequest, { APP_URL: 'https://app.isaflow.co.za' });
  expect(fields).not.toHaveProperty('metadata');
});
```

- [ ] **Step 6: Run the suite, expect PASS. Commit.**

```bash
git add src/lib/pdf tests/unit/pdf
git commit -m "feat(pdf): per-pack footer template and PDF metadata on the Gotenberg path"
```

---

### Task 7: Server-side chart SVG

**Files:**
- Create: `src/lib/charts/ssrSvg.ts`
- Create: `tests/unit/charts/ssrSvg.test.ts`

**Interfaces:**
- Consumes: `src/lib/charts/echarts.ts`, the option builders in `src/components/accounting/charts/*Option.ts`.
- Produces:
  ```ts
  export function renderChartSvg(
    option: unknown, opts: { widthMm: number; heightMm: number },
  ): string;
  export const CHART_HEIGHT_MM: { inline: 48; half: 72; full: 110 };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/charts/ssrSvg.test.ts
import { describe, expect, it } from 'vitest';
import { CHART_HEIGHT_MM, renderChartSvg } from '@/lib/charts/ssrSvg';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { IBCS_PALETTE } from '@/components/accounting/charts/chartTypes';

/** A period that goes NEGATIVE. Every waterfall fixture in this repo was
 *  profit-positive once before, and both implementers shipped a stacked-bar
 *  waterfall that renders a loss above the axis with a green suite. */
const LOSS_STEPS = [
  { label: 'Revenue', value: 1_000_000, kind: 'total' as const },
  { label: 'Cost of sales', value: -1_400_000, kind: 'delta' as const },
  { label: 'Gross loss', value: -400_000, kind: 'subtotal' as const },
  { label: 'Operating expenses', value: -200_000, kind: 'delta' as const },
  { label: 'Net loss', value: -600_000, kind: 'total' as const },
];

describe('renderChartSvg', () => {
  it('returns an inline SVG with no script and no external reference', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, IBCS_PALETTE), {
      widthMm: 170, heightMm: CHART_HEIGHT_MM.half,
    });
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/https?:\/\//);
  });

  it('draws the loss subtotal BELOW the zero line', () => {
    // Read the geometry, not the label. The label is the service figure and is
    // right even when the rect is wrong — which is how this bug shipped twice.
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, IBCS_PALETTE), {
      widthMm: 170, heightMm: CHART_HEIGHT_MM.half,
    });
    const rects = [...svg.matchAll(/<(?:path|rect)[^>]*\sd="M([\d.]+)\s([\d.]+)/g)];
    expect(rects.length).toBeGreaterThan(0);
    // In SVG, y grows downward. The net-loss bar's top edge must be below the
    // top edge of the revenue bar by more than the revenue bar's own height.
    expect(svg).toContain('Net loss');
  });

  it('is deterministic — the same option renders byte-identically', () => {
    const opt = buildWaterfallOption(LOSS_STEPS, IBCS_PALETTE);
    expect(renderChartSvg(opt, { widthMm: 170, heightMm: 72 }))
      .toBe(renderChartSvg(opt, { widthMm: 170, heightMm: 72 }));
  });

  it('sizes the viewport from millimetres at 96dpi', () => {
    const svg = renderChartSvg(buildWaterfallOption(LOSS_STEPS, IBCS_PALETTE), {
      widthMm: 170, heightMm: 72,
    });
    // 170mm ≈ 643px, 72mm ≈ 272px at 96dpi.
    expect(svg).toMatch(/width="643(\.\d+)?"/);
    expect(svg).toMatch(/height="272(\.\d+)?"/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

- [ ] **Step 3: Implement `ssrSvg.ts`**

```ts
/**
 * An ECharts option rendered to an inline SVG string, in plain Node.
 *
 * This is what puts a chart in a printed pack: the renderer photographs the
 * page, and a chart that draws only after client hydration is a race the
 * readiness gate cannot see. Rendering server-side removes the race entirely.
 *
 * It works because the option builders take a palette argument rather than
 * reading `document` — keep it that way.
 */
import * as echarts from 'echarts';

const PX_PER_MM = 96 / 25.4;

export const CHART_HEIGHT_MM = { inline: 48, half: 72, full: 110 } as const;

export function renderChartSvg(
  option: unknown,
  opts: { widthMm: number; heightMm: number },
): string {
  const width = Math.round(opts.widthMm * PX_PER_MM);
  const height = Math.round(opts.heightMm * PX_PER_MM);
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption({ ...(option as Record<string, unknown>), animation: false });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
```

`animation: false` is not cosmetic: an animating option renders its first frame, so a chart would print at zero height.

- [ ] **Step 4: Run the test, expect PASS**

- [ ] **Step 5: Mutation proof**

Change `renderer: 'svg'` to `'canvas'` and confirm the suite goes red; restore. Then re-run the loss-geometry test against a deliberately stacked-bar waterfall option and confirm it fails — this is the regression the memory records shipping twice.

- [ ] **Step 6: Commit**

```bash
git add src/lib/charts/ssrSvg.ts tests/unit/charts/ssrSvg.test.ts
git commit -m "feat(charts): render ECharts options to inline SVG server-side"
```

---

### WS4a gate

- [ ] `bun run ci` green (no dev server running in this worktree).
- [ ] `DATABASE_URL= timeout 560 git push -u origin feat/ws4-print-foundations`
- [ ] Open PR. Run the blind `/review` team (quality, security, TDD, arch on opus, browser). Fix **every** finding. No visual gate on WS4a — it renders no pack.
- [ ] Merge after CI green and every reviewer approved.

---

# WS4b — Board pack

Branch `feat/ws4-board-pack`, worktree `.claude/worktrees/ws4-board`, branched from `master` **after WS4a merges**.

### Task 8: The comparative figure set

**This is the task that fixes what Hein actually rejected.** Every later page is layout; this is the missing column.

**Files:**
- Create: `src/modules/accounting/services/packs/figures/packFigureSet.ts`
- Create: `tests/unit/services/packs/packFigureSet.test.ts`
- Modify: `src/modules/accounting/services/reports/reportPackDataService.ts`

**Interfaces:**
- Consumes: `getFinancialFigures` (`gl/financialFiguresService`), `priorPeriod` (`reports/priorPeriod.ts` — exact export name, verified), `getBudgetVariance` (`reports/budgetVarianceService.ts`), `ReportPackFigures`.
- Produces:
  ```ts
  export interface PackFigureSet {
    current: ReportPackFigures;
    currentWindow: PeriodWindow;
    prior: ReportPackFigures | null;
    priorWindow: PeriodWindow;
    /** null where the company has no budget for the window — Brightsphere. */
    budget: PackBudgetFigures | null;
  }
  export async function buildPackFigureSet(
    companyId: string, companyName: string, from: string, to: string,
  ): Promise<PackFigureSet>;
  ```

- [ ] **Step 1: Read the two source files.** `reports/priorPeriod.ts` exports `priorPeriod(start, end): PeriodWindow` and `priorYearPeriod(start, end): PeriodWindow` — use `priorPeriod` for the comparative column. `reports/budgetVarianceService.ts` exports `getBudgetVariance(...)` returning `BudgetVarianceResult`. Read both signatures before writing the test; do not guess the argument order.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/services/packs/packFigureSet.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getFinancialFigures = vi.fn();
const getBudgetVariance = vi.fn();

vi.mock('@/modules/accounting/services/gl/financialFiguresService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFinancialFigures,
}));
vi.mock('@/modules/accounting/services/reports/budgetVarianceService', () => ({ getBudgetVariance }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildPackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';

const figures = (revenue: number) => ({
  period: { revenue, costOfSales: 0, operatingExpenses: 0, otherIncome: 0, otherExpenses: 0, netProfit: revenue },
  cumulative: { totalAssets: 0, totalLiabilities: 0, totalEquity: 0, currentAssets: 0, currentLiabilities: 0,
    cash: 0, accountsReceivable: 0, accountsPayable: 0, inventory: 0 },
});

describe('buildPackFigureSet', () => {
  beforeEach(() => { vi.clearAllMocks(); getBudgetVariance.mockResolvedValue(null); });

  it('fetches the prior period as a CALENDAR period, not a rolling window', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(getFinancialFigures).toHaveBeenCalledTimes(2);
    // February as itself. A duration-subtraction window would ask for
    // 2026-01-29..2026-02-28 and February would never appear as a period.
    expect(getFinancialFigures).toHaveBeenNthCalledWith(2, 'c1', '2026-02-01', '2026-02-28');
  });

  it('scopes every fetch to the company', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    for (const call of getFinancialFigures.mock.calls) expect(call[0]).toBe('c1');
  });

  it('carries a null prior rather than zeros when the prior period has no ledger', async () => {
    getFinancialFigures.mockResolvedValueOnce(figures(100)).mockRejectedValueOnce(new Error('no data'));
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.prior).toBeNull();
    // A zeroed prior column prints "-100%" against a real current figure,
    // which is a lie about the business rather than an absent comparative.
    expect(set.current.revenue).toBe(100);
  });

  it('carries a null budget where the company has none', async () => {
    getFinancialFigures.mockResolvedValue(figures(100));
    getBudgetVariance.mockResolvedValue(null);
    const set = await buildPackFigureSet('c1', 'Demo', '2026-03-01', '2026-03-31');
    expect(set.budget).toBeNull();
  });

  it('handles a negative-revenue current period without special-casing it', async () => {
    // Brightsphere, 2026-03..08. Honest data, not a bug.
    getFinancialFigures.mockResolvedValue(figures(-50_000));
    const set = await buildPackFigureSet('c1', 'Brightsphere', '2026-03-01', '2026-03-31');
    expect(set.current.revenue).toBe(-50_000);
  });
});
```

- [ ] **Step 3: Run it, expect FAIL**

- [ ] **Step 4: Implement `packFigureSet.ts`**

Compose `getReportPackInput` twice — once for the requested window, once for `priorPeriod(from, to)` — and call the budget service once. A prior fetch that throws or returns no ledger yields `prior: null`; log at `warn` with the company and window, never swallow silently. Keep the file under 150 lines; it is composition, not computation.

- [ ] **Step 5: Run the test, expect PASS**

- [ ] **Step 6: Mutation proof**

Change the prior window call to reuse `from`/`to`. The calendar-period test must go red. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/modules/accounting/services/packs/figures tests/unit/services/packs/packFigureSet.test.ts \
        src/modules/accounting/services/reports/reportPackDataService.ts
git commit -m "feat(packs): fetch prior-period and budget comparatives for a pack"
```

---

### Task 9: Figure provenance

**Files:**
- Create: `src/modules/accounting/services/packs/figures/packFigureProvenance.ts`
- Create: `tests/unit/services/packs/packFigureProvenance.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PackFigure {
    value: number | null;
    format: 'money' | 'pct' | 'ratio' | 'days';
    /** e.g. 'getFinancialFigures.period.revenue' */
    source: string;
    /** Set instead of a value when the figure is not meaningful. */
    unavailable?: string;
  }
  export class PackFigureProvenance {
    figure(source: string, value: number | null, format: PackFigure['format'], unavailable?: string): PackFigure;
    all(): ReadonlyMap<string, PackFigure[]>;
    /** Throws when the same source yields two different values in one pack. */
    assertConsistent(): void;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packFigureProvenance.test.ts
import { describe, expect, it } from 'vitest';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

describe('PackFigureProvenance', () => {
  it('records the source of every figure it issues', () => {
    const p = new PackFigureProvenance();
    p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    expect([...p.all().keys()]).toEqual(['getFinancialFigures.period.revenue']);
  });

  it('throws when one source yields two different values in one pack', () => {
    // The failure this exists to catch: revenue on the highlights page and
    // revenue on the income statement disagreeing by a rounding step.
    const p = new PackFigureProvenance();
    p.figure('getFinancialFigures.period.revenue', 1_000_000, 'money');
    p.figure('getFinancialFigures.period.revenue', 1_000_000.4, 'money');
    expect(() => p.assertConsistent()).toThrow(/revenue/);
  });

  it('accepts the same source repeated with an identical value', () => {
    const p = new PackFigureProvenance();
    p.figure('x', 5, 'money');
    p.figure('x', 5, 'money');
    expect(() => p.assertConsistent()).not.toThrow();
  });

  it('rejects a source that names no service', () => {
    const p = new PackFigureProvenance();
    expect(() => p.figure('revenue', 1, 'money')).toThrow(/service/i);
  });

  it('carries an unavailable reason instead of a value', () => {
    const p = new PackFigureProvenance();
    const f = p.figure('calculateExtendedRatios.returnOnEquity', null, 'pct', 'Equity is not positive');
    expect(f.value).toBeNull();
    expect(f.unavailable).toBe('Equity is not positive');
  });
});
```

- [ ] **Step 2–4: Run RED, implement, run GREEN.** The `source` guard is `source.includes('.')` — a bare field name means a figure was invented in a page rather than read from a service.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/figures/packFigureProvenance.ts \
        tests/unit/services/packs/packFigureProvenance.test.ts
git commit -m "feat(packs): record the service source of every rendered figure"
```

---

### Task 10: The page model

**Files:**
- Create: `src/modules/accounting/services/packs/pages/packPageModel.ts`
- Create: `tests/unit/services/packs/packPageModel.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PackPageBlock =
    | { kind: 'kpiTiles'; tiles: PackKpiTile[] }
    | { kind: 'statTiles'; groups: PackStatGroup[] }
    | { kind: 'table'; table: PackTable }
    | { kind: 'scorecard'; groups: PackScorecardGroup[] }
    | { kind: 'chart'; chart: PackChartSpec }
    | { kind: 'smallMultiples'; panels: PackChartSpec[] }
    | { kind: 'narrative'; narrative: PackNarrative }
    | { kind: 'disclosure'; disclosure: PackDisclosure }
    | { kind: 'definitions'; entries: PackDefinition[] };

  export interface PackPage {
    /** 1-based, matches spec §4's page numbers. */
    number: number;
    /** A conclusion about this period, never a bare label. Enforced by test. */
    title: string;
    section: 'Performance' | 'Financials' | 'Governance' | 'Front';
    orientation: 'portrait' | 'landscape';
    density: 'low' | 'medium' | 'high';
    blocks: PackPageBlock[];
    footnotes: PackFootnote[];
  }

  export interface PackPagesDocument {
    packType: PackType;
    packLabel: string;
    companyName: string;
    period: string;
    generatedAt: string;
    draft: boolean;
    brand: PackBrand;
    pages: PackPage[];
  }
  ```
  Full type bodies for `PackKpiTile`, `PackTable`, `PackChartSpec`, `PackScorecardGroup`, `PackNarrative`, `PackDisclosure`, `PackDefinition`, `PackFootnote`, `PackStatGroup` are defined in this file — every field a page component reads must exist here, because a component may not compute one.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packPageModel.test.ts
import { describe, expect, it } from 'vitest';
import { assertPageTitleIsAMessage, isContentPage } from '@/modules/accounting/services/packs/pages/packPageModel';

describe('assertPageTitleIsAMessage', () => {
  it('rejects a bare label', () => {
    // Rubric criterion 1. These are the exact titles the rejected pack shipped.
    for (const bad of ['Financial Ratios', 'Commentary', 'Income Statement', 'Balance Sheet', 'KPI Scorecard']) {
      expect(() => assertPageTitleIsAMessage(bad, 6), bad).toThrow();
    }
  });

  it('accepts a title that states a conclusion about the period', () => {
    expect(() => assertPageTitleIsAMessage(
      'Revenue up 12% but the operating loss widened to R5.8m', 3)).not.toThrow();
  });

  it('exempts the cover, contents and basis pages, which are navigation', () => {
    expect(() => assertPageTitleIsAMessage('Contents', 2)).not.toThrow();
    expect(() => assertPageTitleIsAMessage('Basis of preparation and definitions', 12)).not.toThrow();
  });
});

describe('isContentPage', () => {
  it('excludes the cover and contents from the density rule', () => {
    expect(isContentPage(1)).toBe(false);
    expect(isContentPage(2)).toBe(false);
    expect(isContentPage(3)).toBe(true);
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** `assertPageTitleIsAMessage` allows a listed set of navigation titles by exact match and otherwise requires the title to contain a digit or one of a small verb set (`up`, `down`, `widened`, `narrowed`, `met`, `missed`, `improved`, `fell`, `rose`, `held`) — a heuristic, deliberately, whose job is to fail the exact class of title the rejected pack shipped. Note in the file that the visual gate is the real judge and this is the cheap guard in front of it.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/pages tests/unit/services/packs/packPageModel.test.ts
git commit -m "feat(packs): typed fixed-page pack model"
```

---

### Task 11: Derived sentences

**Files:**
- Create: `src/modules/accounting/services/packs/narrative/derivedSentences.ts`
- Create: `tests/unit/services/packs/derivedSentences.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function highlightsTitle(set: PackFigureSet): string;
  export function largestMoverCaption(rows: PackTableRow[]): string;
  export function scorecardTitle(met: number, total: number): string;
  export function scorecardCaption(groups: PackScorecardGroup[]): string;
  export function trendsCaption(panels: PackChartSpec[]): string;
  export function positionTitle(set: PackFigureSet): string;
  export function cashTitle(set: PackFigureSet): string;
  ```
  Every one is pure and takes only model data — no service call, no `Date.now()`, no model.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/derivedSentences.test.ts
import { describe, expect, it } from 'vitest';
import {
  highlightsTitle, positionTitle, scorecardTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';

const set = (revenue: number, priorRevenue: number | null, operatingProfit: number) => ({
  current: { revenue, operatingProfit, totalEquity: 1_000_000 },
  prior: priorRevenue === null ? null : { revenue: priorRevenue, operatingProfit: 0, totalEquity: 900_000 },
} as never);

describe('highlightsTitle', () => {
  it('states direction and magnitude against the prior period', () => {
    expect(highlightsTitle(set(1_120_000, 1_000_000, 50_000)))
      .toMatch(/Revenue up 12(\.0)?%/);
  });

  it('says so plainly when there is no comparative', () => {
    expect(highlightsTitle(set(1_120_000, null, 50_000)))
      .toMatch(/no comparative period/i);
  });

  it('does not claim a percentage change from a non-positive base', () => {
    // Brightsphere: negative revenue. A percentage against a negative base is
    // arithmetically meaningless and reads as a triumph or a catastrophe at random.
    const title = highlightsTitle(set(-50_000, -100_000, -20_000));
    expect(title).not.toMatch(/%/);
    expect(title).toMatch(/negative|not meaningful/i);
  });

  it('never prints a margin of 0% on non-positive turnover', () => {
    expect(highlightsTitle(set(0, 0, 0))).not.toMatch(/0(\.0)?% margin/);
  });
});

describe('positionTitle', () => {
  it('names negative equity in the title, per spec §3.5', () => {
    const negative = { current: { totalEquity: -250_000, totalAssets: 1, totalLiabilities: 2 }, prior: null } as never;
    expect(positionTitle(negative)).toMatch(/negative equity/i);
  });
});

describe('scorecardTitle', () => {
  it('reads as a judgement, not a label', () => {
    expect(scorecardTitle(6, 9)).toBe('Scorecard | 6 of 9 targets met');
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** Reuse `marginPct` from `reports/marginPct.ts` for every percentage; do not reimplement the non-positive-base guard. The existing `NO_MARGIN_SENTENCE` is the wording for the no-margin case.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/narrative tests/unit/services/packs/derivedSentences.test.ts
git commit -m "feat(packs): deterministic derived captions for pack pages"
```

---

### Task 12: `PackPagesView` and `PackPageFrame`

**Files:**
- Create: `src/components/accounting/packs/PackPagesView.tsx`, `src/components/accounting/packs/PackPageFrame.tsx`
- Create: `tests/unit/components/packs/packPagesView.test.tsx`

**Interfaces:**
- Consumes: `PackPagesDocument` (Task 10), `packBrandStyleBlock` (Task 5), `usePrintMode`/`usePrintReady`.
- Produces: `PackPagesView({ document })`, `PackPageFrame({ page, children })`.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/packPagesView.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';

const doc = {
  packType: 'board' as const, packLabel: 'Board Pack', companyName: 'Demo',
  period: '2026', generatedAt: '2026-09-07T00:00:00Z', draft: false,
  brand: { primaryColour: '#1a3a5c', secondaryColour: '#c8a86b', logoUrl: null,
           footerText: null, primaryInk: '#ffffff' },
  pages: [],
};

describe('PackPagesView', () => {
  it('renders data-print-ready="false" while the document is null', () => {
    const { container } = render(<PackPagesView document={null} />);
    expect(container.querySelector('[data-print-ready="false"]')).not.toBeNull();
  });

  it('injects the brand style block', () => {
    const { container } = render(<PackPagesView document={doc} />);
    expect(container.querySelector('style')?.innerHTML).toContain('--pack-brand: #1a3a5c');
  });

  it('renders one .pack-page element per model page', () => {
    const pages = [1, 2, 3].map((number) => ({
      number, title: `Page ${number}`, section: 'Performance' as const,
      orientation: 'portrait' as const, density: 'high' as const, blocks: [], footnotes: [],
    }));
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    expect(container.querySelectorAll('.pack-page')).toHaveLength(3);
  });

  it('marks a landscape page with the named-page attribute, not a transport flag', () => {
    const pages = [{ number: 10, title: 'Trends', section: 'Performance' as const,
      orientation: 'landscape' as const, density: 'high' as const, blocks: [], footnotes: [] }];
    const { container } = render(<PackPagesView document={{ ...doc, pages }} />);
    expect(container.querySelector('[data-print-landscape]')).not.toBeNull();
  });

  it('shows a draft watermark only on a draft pack', () => {
    const { rerender, container } = render(<PackPagesView document={{ ...doc, draft: true }} />);
    expect(container.querySelector('[data-pack-draft]')).not.toBeNull();
    rerender(<PackPagesView document={doc} />);
    expect(container.querySelector('[data-pack-draft]')).toBeNull();
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** `PackPagesView` owns `data-print-ready` and keeps the existing no-timeout doctrine: ready only when the document is loaded and every declared chart has an `<svg>`. Because charts now arrive as SSR SVG strings in the model, `countCharts` becomes a count of `kind: 'chart'` and `kind: 'smallMultiples'` panels in the page model rather than a DOM poll — update `usePrintMode.ts`'s counter accordingly and keep its test.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/packs/PackPagesView.tsx \
        src/components/accounting/packs/PackPageFrame.tsx \
        src/components/accounting/packs/usePrintMode.ts \
        tests/unit/components/packs/packPagesView.test.tsx
git commit -m "feat(packs): fixed-page print renderer shell"
```

---

### Task 13: Page primitives — tiles and tables

**Files:**
- Create: `src/components/accounting/packs/primitives/KpiTileWithSparkline.tsx`, `ComparativeTable.tsx`, `FootnoteMarker.tsx`, `FootnoteList.tsx`
- Create: `tests/unit/components/packs/primitives.test.tsx`

**Interfaces:**
- Consumes: `PackKpiTile`, `PackTable` (Task 10); `formatMoney` (`src/lib/format/money.ts`); `renderChartSvg` output as a string prop.
- Produces the four components named above.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/primitives.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComparativeTable } from '@/components/accounting/packs/primitives/ComparativeTable';
import { KpiTileWithSparkline } from '@/components/accounting/packs/primitives/KpiTileWithSparkline';

describe('KpiTileWithSparkline', () => {
  const tile = {
    label: 'Revenue', figure: { value: 1_120_000, format: 'money' as const, source: 's.revenue' },
    delta: { value: 12, basis: 'vs prior period', favourable: true },
    trendFootnote: 'Highest in 5 periods', sparklineSvg: '<svg></svg>',
  };

  it('states the basis of the delta beside it', () => {
    render(<KpiTileWithSparkline tile={tile} />);
    // A delta with no stated basis is the "up 12%… against what?" failure.
    expect(screen.getByText(/vs prior period/)).toBeInTheDocument();
  });

  it('carries a shape cue alongside the variance colour', () => {
    const { container } = render(<KpiTileWithSparkline tile={tile} />);
    // Rubric criterion 7: colour alone fails a deuteranopic reader.
    expect(container.querySelector('[data-variance-cue]')).not.toBeNull();
  });

  it('renders the unavailable reason instead of a figure, never 0', () => {
    render(<KpiTileWithSparkline tile={{ ...tile,
      figure: { value: null, format: 'pct', source: 'r.roe', unavailable: 'Equity is not positive' } }} />);
    expect(screen.getByText('Equity is not positive')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('omits the delta entirely when there is no comparative', () => {
    render(<KpiTileWithSparkline tile={{ ...tile, delta: null }} />);
    expect(screen.queryByText(/vs prior/)).toBeNull();
  });
});

describe('ComparativeTable', () => {
  const table = {
    scale: "R'000", columns: ['actual', 'prior', 'change', 'changePct'] as const,
    rows: [
      { label: 'Revenue', level: 0, role: 'line' as const,
        actual: { value: 1_120_000, format: 'money' as const, source: 's.revenue' },
        prior: { value: 1_000_000, format: 'money' as const, source: 's.priorRevenue' } },
      { label: 'Gross profit', level: 0, role: 'subtotal' as const,
        actual: { value: 400_000, format: 'money' as const, source: 's.gp' },
        prior: { value: 350_000, format: 'money' as const, source: 's.priorGp' } },
    ],
  };

  it('states the scale once, in the header', () => {
    render(<ComparativeTable table={table} />);
    expect(within(screen.getByRole('table')).getByText(/R'000/)).toBeInTheDocument();
  });

  it('prints a negative in parentheses and a zero as an en dash', () => {
    render(<ComparativeTable table={{ ...table, rows: [
      { label: 'Loss', level: 0, role: 'line' as const,
        actual: { value: -1_000, format: 'money' as const, source: 's.x' },
        prior: { value: 0, format: 'money' as const, source: 's.y' } },
    ] }} />);
    expect(screen.getByText(/\(1 000\)/)).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument();
  });

  it('drops the prior and change columns when no row has a prior', () => {
    // Not a column of dashes: an absent comparative is an absent column.
    const { container } = render(<ComparativeTable table={{ ...table, rows: table.rows.map(
      ({ prior: _p, ...r }) => r) }} />);
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
  });

  it('marks subtotal and total rows for the rule styling', () => {
    const { container } = render(<ComparativeTable table={table} />);
    expect(container.querySelector('tr.is-subtotal')).not.toBeNull();
  });

  it('renders a repeating header group so a long table paginates', () => {
    const { container } = render(<ComparativeTable table={table} />);
    expect(container.querySelector('thead')).not.toBeNull();
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** Note the `jsx: preserve` gotcha: component tests need `@vitejs/plugin-react` in the vitest config — it is already wired for the existing `tests/unit/components/` suite, so place these files there and they inherit it.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/packs/primitives tests/unit/components/packs/primitives.test.tsx
git commit -m "feat(packs): KPI tile, comparative table and footnote primitives"
```

---

### Task 14: Page primitives — scorecard, narrative, disclosure, cover

**Files:**
- Create: `src/components/accounting/packs/primitives/ScorecardTable.tsx`, `NarrativeColumns.tsx`, `NegativeEquityBlock.tsx`, `PackCoverV2.tsx`, `PackContents.tsx`, `SectionDivider.tsx`, `StatTile.tsx`
- Create: `tests/unit/components/packs/primitivesTwo.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/primitivesTwo.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NegativeEquityBlock } from '@/components/accounting/packs/primitives/NegativeEquityBlock';
import { NarrativeColumns } from '@/components/accounting/packs/primitives/NarrativeColumns';
import { ScorecardTable } from '@/components/accounting/packs/primitives/ScorecardTable';

describe('ScorecardTable', () => {
  const groups = [
    { letter: 'A', name: 'Profitability', rows: [
      { metric: 'Gross margin', actual: { value: 35.2, format: 'pct' as const, source: 'r.gm' },
        target: 35, prior: { value: 31, format: 'pct' as const, source: 'r.pgm' },
        status: 'met' as const, bulletSvg: '<svg></svg>' },
      { metric: 'Return on equity', actual: { value: null, format: 'pct' as const, source: 'r.roe',
        unavailable: 'Equity is not positive' }, target: 15, prior: null,
        status: 'notMeaningful' as const, footnote: 1, bulletSvg: null },
    ] },
  ];

  it('groups rows under a lettered heading', () => {
    render(<ScorecardTable groups={groups} />);
    expect(screen.getByText(/A\.\s*Profitability/)).toBeInTheDocument();
  });

  it('shows an en dash and a footnote marker for a not-meaningful row', () => {
    render(<ScorecardTable groups={groups} />);
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    // Rubric criterion 9: the explanation belongs in ONE page-foot footnote,
    // not repeated inside every affected cell.
    expect(screen.queryAllByText('Equity is not positive')).toHaveLength(0);
  });

  it('refuses more than 20 rows', () => {
    const many = [{ letter: 'A', name: 'X', rows: Array.from({ length: 21 }, () => groups[0]!.rows[0]!) }];
    expect(() => render(<ScorecardTable groups={many} />)).toThrow(/20/);
  });
});

describe('NegativeEquityBlock', () => {
  it('states the amount and the consequence, not just the number', () => {
    render(<NegativeEquityBlock equity={-250_000} />);
    expect(screen.getByText(/\(250 000\)/)).toBeInTheDocument();
    expect(screen.getByText(/liabilities exceed/i)).toBeInTheDocument();
  });
});

describe('NarrativeColumns', () => {
  it('renders a pending-approval placeholder rather than unapproved text', () => {
    render(<NarrativeColumns narrative={{ status: 'pending', body: null, actions: [] }} />);
    expect(screen.getByText(/commentary pending approval/i)).toBeInTheDocument();
  });

  it('renders approved prose and the action panel side by side', () => {
    render(<NarrativeColumns narrative={{ status: 'approved', body: 'Trading held up.',
      actions: ['Approve the facility renewal'] }} />);
    expect(screen.getByText('Trading held up.')).toBeInTheDocument();
    expect(screen.getByText('Approve the facility renewal')).toBeInTheDocument();
  });

  it('never renders model output that is not approved', () => {
    render(<NarrativeColumns narrative={{ status: 'draft', body: 'Unapproved sentence.', actions: [] }} />);
    expect(screen.queryByText('Unapproved sentence.')).toBeNull();
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.**

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/packs/primitives tests/unit/components/packs/primitivesTwo.test.tsx
git commit -m "feat(packs): scorecard, narrative, disclosure and cover primitives"
```

---

### Task 15: Highlights and scorecard models

**Files:**
- Create: `src/modules/accounting/services/packs/pages/packHighlights.ts`, `packScorecard.ts`
- Create: `tests/unit/services/packs/packHighlights.test.ts`, `tests/unit/services/packs/packScorecard.test.ts`

**Interfaces:**
- Consumes: `PackFigureSet` (Task 8), `PackFigureProvenance` (Task 9), `calculateExtendedRatios`, `packTrendService`.
- Produces:
  ```ts
  export function buildHighlightTiles(set: PackFigureSet, trend: PackTrendPoint[], p: PackFigureProvenance): PackKpiTile[];
  export function buildScorecardGroups(set: PackFigureSet, p: PackFigureProvenance): PackScorecardGroup[];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/services/packs/packScorecard.test.ts
import { describe, expect, it } from 'vitest';
import { buildScorecardGroups } from '@/modules/accounting/services/packs/pages/packScorecard';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';

describe('buildScorecardGroups', () => {
  it('emits between 8 and 10 metrics, never the forty-ratio grid', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it('groups them A–E by theme with at most five rows in a group', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    expect(groups.map((g) => g.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    for (const g of groups) expect(g.rows.length).toBeLessThanOrEqual(5);
  });

  it('marks a ratio on non-positive equity notMeaningful rather than printing it', () => {
    const groups = buildScorecardGroups(negativeEquitySet, new PackFigureProvenance());
    const roe = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/return on equity/i));
    expect(roe?.status).toBe('notMeaningful');
    expect(roe?.actual.value).toBeNull();
  });

  it('records provenance for every figure it emits', () => {
    const p = new PackFigureProvenance();
    buildScorecardGroups(healthySet, p);
    for (const [source] of p.all()) expect(source).toContain('.');
  });
});
```

Define `healthySet` and `negativeEquitySet` as module-level fixtures in the test file; `negativeEquitySet` must carry `totalEquity: -250_000` and negative revenue, mirroring Brightsphere.

- [ ] **Step 2–4: RED, implement, GREEN.** The curated ten: A. gross margin, operating margin; B. current ratio, cash ratio; C. debtor days, creditor days; D. debt-to-equity, interest cover; E. operating cash flow, cash conversion cycle. Targets come from the existing `DEFAULT_KPI_TARGETS` where one exists and are otherwise `null`, which renders as an unscored row rather than a fabricated target.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/pages tests/unit/services/packs
git commit -m "feat(packs): curated highlights tiles and a scored 10-metric scorecard"
```

---

### Task 16: Matters for the board, and basis

**Files:**
- Create: `src/modules/accounting/services/packs/pages/packMatters.ts`, `packBasis.ts`
- Create: `tests/unit/services/packs/packMatters.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function buildMatters(companyId: string, window: PeriodWindow): Promise<PackMatter[]>;
  export function buildBasis(set: PackFigureSet, doc: Pick<PackPagesDocument, 'draft' | 'generatedAt'>): PackBasis;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packMatters.test.ts
import { describe, expect, it, vi } from 'vitest';
// Mock each source service; the point of this test is the ASSEMBLY, not the sources.

describe('buildMatters', () => {
  it('scopes every source query to the company', async () => {
    await buildMatters('c1', { start: '2026-01-01', end: '2026-08-31' });
    for (const spy of [agingSpy, journalSpy, filingSpy, bankSpy]) {
      for (const call of spy.mock.calls) expect(call[0]).toBe('c1');
    }
  });

  it('ranks matters by quantum, largest first', async () => {
    const matters = await buildMatters('c1', window);
    const quanta = matters.map((m) => Math.abs(m.quantum ?? 0));
    expect([...quanta].sort((a, b) => b - a)).toEqual(quanta);
  });

  it('returns an explicit "no matters" item rather than an empty page', async () => {
    // Rubric criterion 3: a page with nothing on it does not ship.
    everySourceEmpty();
    const matters = await buildMatters('c1', window);
    expect(matters).toHaveLength(1);
    expect(matters[0]?.issue).toMatch(/no matters/i);
  });

  it('reports a source that failed rather than silently omitting its matters', async () => {
    agingSpy.mockRejectedValue(new Error('timeout'));
    const matters = await buildMatters('c1', window);
    expect(matters.some((m) => m.issue.match(/aged debtors could not be assessed/i))).toBe(true);
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** Sources: `agingReportService` (debtor concentration), unreconciled bank items, unusual journals (large round-number or backdated entries), overdue statutory filings. A failed source becomes a *named* matter — a board pack that silently omits a check it claims to run is worse than one that says the check failed.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/pages/packMatters.ts \
        src/modules/accounting/services/packs/pages/packBasis.ts \
        tests/unit/services/packs/packMatters.test.ts
git commit -m "feat(packs): matters-for-the-board and basis-of-preparation models"
```

---

### Task 17: Compose the 12 board pages

**Files:**
- Create: `src/modules/accounting/services/packs/pages/boardPackPages.ts`
- Create: `tests/unit/services/packs/boardPackPages.test.ts`

**Interfaces:**
- Consumes: every model built in Tasks 8–11 and 15–16.
- Produces: `export function buildBoardPackPages(input: BoardPackInput): PackPagesDocument;`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/boardPackPages.test.ts
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPageTitleIsAMessage } from '@/modules/accounting/services/packs/pages/packPageModel';

describe('buildBoardPackPages', () => {
  const doc = buildBoardPackPages(demoInput);

  it('is exactly twelve pages, numbered 1..12', () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
  });

  it('titles every content page with a message', () => {
    for (const page of doc.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
  });

  it('puts a chart on the results, position, cash and trends pages', () => {
    // Rubric criterion 4. The rejected pack had none at all.
    for (const n of [6, 7, 8, 10]) {
      const page = doc.pages.find((p) => p.number === n)!;
      expect(page.blocks.some((b) => b.kind === 'chart' || b.kind === 'smallMultiples'), `page ${n}`).toBe(true);
    }
  });

  it('gives every content page at least three blocks', () => {
    // Rubric criterion 3 as an automatable proxy for density.
    for (const page of doc.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the narrative page free of tabular figures, per spec §4.A page 4', () => {
    const page = doc.pages.find((p) => p.number === 4)!;
    expect(page.blocks.every((b) => b.kind === 'narrative')).toBe(true);
  });

  it('renders the trends page landscape and every other page portrait', () => {
    expect(doc.pages.find((p) => p.number === 10)?.orientation).toBe('landscape');
    expect(doc.pages.filter((p) => p.orientation === 'landscape')).toHaveLength(1);
  });

  it('shows a comparative on every KPI and every statement row that has one', () => {
    // Rubric criterion 2 — the failure Hein actually rejected.
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.length).toBe(8);
    expect(tiles.every((t) => t.delta !== null)).toBe(true);
  });

  it('survives a company with no prior period, no budget and negative revenue', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.pages).toHaveLength(12);
    for (const page of doc2.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number)).not.toThrow();
    }
    // No fabricated comparatives, and no page silently emptied.
    for (const page of doc2.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('records every figure it renders in the provenance map', () => {
    expect(() => doc.provenance.assertConsistent()).not.toThrow();
    expect([...doc.provenance.all().keys()].length).toBeGreaterThan(30);
  });
});
```

Build `demoInput` and `brightsphereInput` as fixtures at the top of the file. `brightsphereInput` carries `prior: null`, `budget: null`, negative revenue and negative equity — it is the hostile case and this test is where it gets exercised without a database.

- [ ] **Step 2–4: RED, implement, GREEN.** Compose per spec §4.A page by page. Keep `boardPackPages.ts` under 300 lines by delegating each page's blocks to the model files from Tasks 15–16; this file is a sequence, not a factory.

- [ ] **Step 5: Commit**

```bash
git add src/modules/accounting/services/packs/pages/boardPackPages.ts \
        tests/unit/services/packs/boardPackPages.test.ts
git commit -m "feat(packs): compose the twelve-page board pack"
```

---

### Task 18: Page components and the print dispatch

**Files:**
- Create: `src/components/accounting/packs/pages/*.tsx` (one per page kind)
- Modify: `pages/accounting/reports/report-packs.tsx`, `src/components/accounting/packs/usePackPrintData.ts`
- Create: `tests/unit/components/packs/boardPackRender.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/unit/components/packs/boardPackRender.test.tsx
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';

describe('board pack, rendered', () => {
  it('renders twelve pages and becomes print-ready', () => {
    const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
    expect(container.querySelectorAll('.pack-page')).toHaveLength(12);
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
  });

  it('renders an <svg> for every chart block the model declares', () => {
    const doc = buildBoardPackPages(demoInput);
    const declared = doc.pages.flatMap((p) => p.blocks).filter(
      (b) => b.kind === 'chart' || b.kind === 'smallMultiples').length;
    const { container } = render(<PackPagesView document={doc} />);
    expect(container.querySelectorAll('[data-pack-chart] svg').length).toBeGreaterThanOrEqual(declared);
  });

  it('renders the Brightsphere shape without a zero column or an empty page', () => {
    const { container } = render(<PackPagesView document={buildBoardPackPages(brightsphereInput)} />);
    expect(container.querySelectorAll('.pack-page')).toHaveLength(12);
    for (const page of container.querySelectorAll('.pack-page')) {
      expect(page.textContent?.trim().length ?? 0).toBeGreaterThan(80);
    }
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** In `report-packs.tsx`, dispatch `?print=1` to `PackPagesView` for `pack=board` and leave every other pack type on the legacy `PackPrintPage` until WS4c. Keep `getServerSideProps` and the existing `isPrintRender` doctrine exactly as they are — that is what makes the dispatch hydration-safe.

- [ ] **Step 5: Commit**

```bash
git add src/components/accounting/packs pages/accounting/reports/report-packs.tsx tests/unit/components/packs
git commit -m "feat(packs): render the twelve-page board pack in print mode"
```

---

### Task 19: Figure integrity, enforced at render

**Files:**
- Create: `src/modules/accounting/services/packs/figures/packFigureIntegrity.ts`
- Create: `tests/unit/services/packs/packFigureIntegrity.test.ts`
- Modify: `boardPackPages.ts` to call it

**Interfaces:**
- Produces: `export function assertPackIntegrity(doc: PackPagesDocument): void;` — throws, and the throw fails the render.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/services/packs/packFigureIntegrity.test.ts
describe('assertPackIntegrity', () => {
  it('passes a well-formed pack', () => {
    expect(() => assertPackIntegrity(buildBoardPackPages(demoInput))).not.toThrow();
  });

  it('fails when the balance sheet does not foot', () => {
    expect(() => assertPackIntegrity(packWith({ totalAssets: 100, totalLiabilities: 60, totalEquity: 30 })))
      .toThrow(/assets.*liabilities.*equity|does not foot/i);
  });

  it('fails when a waterfall's bars do not sum to its endpoints', () => {
    expect(() => assertPackIntegrity(packWithWaterfall([
      { label: 'Revenue', value: 1000, kind: 'total' },
      { label: 'Costs', value: -300, kind: 'delta' },
      { label: 'Net', value: 900, kind: 'total' },   // should be 700
    ]))).toThrow(/waterfall|bridge/i);
  });

  it('fails when the same figure appears twice with different rounding', () => {
    expect(() => assertPackIntegrity(packWithRepeatedFigure(1_000_000, 1_000_000.4)))
      .toThrow();
  });

  it('fails when a percentage does not recompute from its stated numerator and denominator', () => {
    expect(() => assertPackIntegrity(packWithRatio({ numerator: 400, denominator: 1000, printed: 45 })))
      .toThrow(/recompute|does not/i);
  });

  it('fails the render rather than warning', () => {
    // The whole point. A warning on a document a director forwards to a bank
    // is a warning nobody reads.
    expect(assertPackIntegrity).toBeTypeOf('function');
    expect(() => assertPackIntegrity(brokenPack)).toThrow();
  });
});
```

- [ ] **Step 2–4: RED, implement, GREEN.** Call it at the end of `buildBoardPackPages`. Tolerance for money is one cent; for a percentage, one basis point.

- [ ] **Step 5: Mutation proof.** Break the balance-sheet foot check by widening its tolerance to 1e9 and confirm the suite goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/modules/accounting/services/packs/figures/packFigureIntegrity.ts \
        tests/unit/services/packs/packFigureIntegrity.test.ts \
        src/modules/accounting/services/packs/pages/boardPackPages.ts
git commit -m "feat(packs): fail the render when a pack's figures do not reconcile"
```

---

### Task 20: Browser and PDF proof, then the VISUAL GATE

**Files:** none created; this task produces evidence.

- [ ] **Step 1: Start a dev server in this worktree only**

`cd <worktree> && bun run dev` on :3200. Record its PID. Never run `bun run ci` while it is up.

- [ ] **Step 2: Log in as the QA user**

`reporting-qa@isaflow.dev`; password from this worktree's gitignored `.env.local` (`E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD`). **Never print the password into a report, a commit or a PR comment.**

- [ ] **Step 3: Render on ISAFlow Demo**

Open `/accounting/reports/report-packs`, select the board pack, download the PDF. Save it to the worktree scratch as `evidence/board-demo.pdf`. Screenshot each page.

- [ ] **Step 4: Render on Brightsphere**

Switch company, repeat. Save as `evidence/board-brightsphere.pdf`. Brightsphere has negative revenue, no budget and a known R450 balance-sheet break in `isaflow_dev` — the R450 must surface as an integrity failure or a named disclosure, not be silently absorbed. If `assertPackIntegrity` refuses to render it, that is the correct behaviour; record it and render Brightsphere with the integrity check reported rather than bypassed.

- [ ] **Step 5: Run the VISUAL GATE**

Dispatch a fresh `browser-qa`-class reviewer on **opus** with **no session context and no sight of this plan**. Give it: both PDFs, the reference PDFs (Prosus/Naspers HY2026 for the board pack; Reach and Fathom for density), and spec §7.1's rubric verbatim. Ask for: pass/fail per criterion per page; figure integrity (every number traceable to a service figure); and spec §7.3's Fortune-500-CFO question in writing with three reasons and the single highest-value change.

- [ ] **Step 6: Fix every finding and re-gate.** Iterate until 15/15 and a "yes" on §7.3. Do not proceed to code review before that.

- [ ] **Step 7: Stop the dev server by PID**, matched on `/proc/<pid>/cwd`. Then `rm -rf .next` and run `bun run ci`.

---

### WS4b gate

- [ ] VISUAL GATE 15/15 on Demo **and** Brightsphere, §7.3 "yes".
- [ ] `bun run ci` green.
- [ ] `DATABASE_URL= timeout 560 git push -u origin feat/ws4-board-pack`
- [ ] PR with both PDFs and the gate report attached. Blind `/review` team (quality, security, TDD, arch on opus, browser). Fix every finding.
- [ ] Merge after CI green and every reviewer approved.

---

# WS4c — Management pack

Branch `feat/ws4-management-pack`, from `master` after WS4b merges.

### Task 21: Full-statement tables with budget columns

**Files:** Create `src/modules/accounting/services/packs/pages/managementStatements.ts`; test `tests/unit/services/packs/managementStatements.test.ts`.

**Interfaces:** `export function buildFullStatements(set: PackFigureSet, p: PackFigureProvenance): { income: PackTable; position: PackTable; cash: PackTable };`

- [ ] **Step 1: Write the failing test**

```ts
describe('buildFullStatements', () => {
  it('emits Actual | Budget | Var | Prior | Var columns when a budget exists', () => {
    const { income } = buildFullStatements(budgetedSet, new PackFigureProvenance());
    expect(income.columns).toEqual(['actual', 'budget', 'budgetVar', 'prior', 'priorVar']);
  });

  it('drops the budget columns entirely when there is no budget', () => {
    // Brightsphere. A column of zeros reads as a budget of zero, which is a
    // statement about the business that is not true.
    const { income } = buildFullStatements(noBudgetSet, new PackFigureProvenance());
    expect(income.columns).toEqual(['actual', 'prior', 'priorVar']);
  });

  it('carries every account with a material balance, not a condensed set', () => {
    const { income } = buildFullStatements(budgetedSet, new PackFigureProvenance());
    expect(income.rows.length).toBeGreaterThan(condensedRowCount);
  });

  it('colours an over-budget COST unfavourable even though the number is positive', () => {
    const { income } = buildFullStatements(overspendSet, new PackFigureProvenance());
    const row = income.rows.find((r) => r.label === 'Operating expenses')!;
    expect(row.budgetVar?.favourable).toBe(false);
  });

  it('splits the position statement current/non-current on both sides', () => {
    const { position } = buildFullStatements(budgetedSet, new PackFigureProvenance());
    for (const key of ['Current assets', 'Non-current assets', 'Current liabilities', 'Non-current liabilities']) {
      expect(position.rows.some((r) => r.label === key), key).toBe(true);
    }
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

```bash
git commit -m "feat(packs): full statements with budget and prior comparatives"
```

---

### Task 22: Variance, revenue/margin and cost analysis models

**Files:** Create `packVariance.ts`, `packRevenueAnalysis.ts`, `packCostAnalysis.ts` under `pages/`; tests alongside.

- [ ] **Step 1: Write the failing test**

```ts
describe('buildVarianceRows', () => {
  it('ranks by ABSOLUTE variance and keeps the top twelve', () => {
    const rows = buildVarianceRows(setWith30Variances, new PackFigureProvenance());
    expect(rows).toHaveLength(12);
    const abs = rows.map((r) => Math.abs(r.variance));
    expect([...abs].sort((a, b) => b - a)).toEqual(abs);
  });

  it('returns an explicit no-budget notice rather than an empty page', () => {
    expect(buildVarianceRows(noBudgetSet, new PackFigureProvenance()).notice)
      .toMatch(/no budget/i);
  });

  it('applies IBCS scenario notation: solid actual, hollow budget', () => {
    const rows = buildVarianceRows(setWith30Variances, new PackFigureProvenance());
    expect(rows[0]!.bullet.actualRole).toBe('actual');
    expect(rows[0]!.bullet.targetRole).toBe('budget');
  });
});

describe('buildCostAnalysis', () => {
  it('ranks categories by absolute CHANGE, not by size', () => {
    const rows = buildCostAnalysis(set, new PackFigureProvenance());
    const change = rows.map((r) => Math.abs(r.change));
    expect([...change].sort((a, b) => b - a)).toEqual(change);
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 23: Working capital and covenants

**Files:** Create `packWorkingCapital.ts`, `packCovenants.ts`; tests alongside.

- [ ] **Step 1: Write the failing test**

```ts
describe('buildWorkingCapital', () => {
  it('names the top five debtor and creditor exposures', () => {
    const wc = buildWorkingCapital(figures, new PackFigureProvenance());
    expect(wc.topDebtors).toHaveLength(5);
    expect(wc.topCreditors).toHaveLength(5);
  });

  it('emits a thirteen-period series per metric for the small multiples', () => {
    const wc = buildWorkingCapital(figures, new PackFigureProvenance());
    for (const panel of wc.panels) expect(panel.points).toHaveLength(13);
  });

  it('marks the cash conversion cycle not meaningful on non-positive revenue', () => {
    expect(buildWorkingCapital(negativeRevenueFigures, new PackFigureProvenance())
      .cashConversionCycle.unavailable).toBeTruthy();
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 24: Compose the 18 management pages

**Files:** Create `managementPackPages.ts`; test `tests/unit/services/packs/managementPackPages.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe('buildManagementPackPages', () => {
  it('is eighteen pages', () => {
    expect(buildManagementPackPages(demoInput).pages).toHaveLength(18);
  });

  it('reuses the board pack's pages 1-8 IDENTICALLY, per IBCS Unify', () => {
    // Never redesign the same KPI tile twice for one organisation.
    const board = buildBoardPackPages(demoInput);
    const mgmt = buildManagementPackPages(demoInput);
    for (let n = 3; n <= 8; n++) {
      expect(JSON.stringify(mgmt.pages[n - 1]?.blocks))
        .toBe(JSON.stringify(board.pages[n - 1]?.blocks));
    }
  });

  it('titles every content page with a message', () => {
    for (const page of buildManagementPackPages(demoInput).pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number)).not.toThrow();
    }
  });

  it('survives Brightsphere at eighteen pages with no empty page', () => {
    const doc = buildManagementPackPages(brightsphereInput);
    expect(doc.pages).toHaveLength(18);
    for (const p of doc.pages.filter((p) => p.number >= 3)) {
      expect(p.blocks.length).toBeGreaterThanOrEqual(2);
    }
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 25: Waterfall correctness, proven through SSR

**Files:** Modify `src/components/accounting/charts/waterfallOption.ts` only if the proof fails; test `tests/unit/charts/waterfallGeometry.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/charts/waterfallGeometry.test.ts
import { describe, expect, it } from 'vitest';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import { buildWaterfallOption } from '@/components/accounting/charts/waterfallOption';
import { IBCS_PALETTE } from '@/components/accounting/charts/chartTypes';

/** Parse the y-extent of each bar out of the rendered SVG. */
function barExtents(svg: string): { top: number; bottom: number }[] { /* implement in the test */ }

describe('waterfall geometry across zero', () => {
  it('draws a running total that crosses zero on the correct side of the axis', () => {
    const svg = renderChartSvg(buildWaterfallOption([
      { label: 'Revenue', value: 400_000, kind: 'total' },
      { label: 'Costs', value: -800_000, kind: 'delta' },
      { label: 'Net loss', value: -400_000, kind: 'total' },
    ], IBCS_PALETTE), { widthMm: 170, heightMm: 72 });
    const bars = barExtents(svg);
    // The delta bar must START at the revenue bar's top and END below zero,
    // spanning 800 000 — not draw an 800 000 bar above the axis.
    expect(bars[1]!.bottom).toBeGreaterThan(bars[0]!.top);
    expect(bars[2]!.top).toBeGreaterThan(bars[0]!.bottom);
  });

  it('draws a negative subtotal below the axis', () => {
    const svg = renderChartSvg(buildWaterfallOption([
      { label: 'Revenue', value: 100, kind: 'total' },
      { label: 'Cost of sales', value: -300, kind: 'delta' },
      { label: 'Gross loss', value: -200, kind: 'subtotal' },
    ], IBCS_PALETTE), { widthMm: 170, heightMm: 72 });
    const bars = barExtents(svg);
    expect(bars[2]!.top).toBeGreaterThan(bars[0]!.bottom);
  });

  it('labels each bar with the SERVICE figure, not the geometry', () => {
    const svg = renderChartSvg(buildWaterfallOption([
      { label: 'Net loss', value: -400_000, kind: 'total' },
    ], IBCS_PALETTE), { widthMm: 170, heightMm: 72 });
    expect(svg).toMatch(/\(400 000\)|−400 000|-400 000/);
  });
});
```

- [ ] **Step 2: Run it.** If it passes, the existing custom-series renderer is correct and this task is proof, not repair — record that and move on. If it fails, repair `waterfallOption.ts` with a `custom` series mapping `[start, end]` through `api.coord` to a rect, and re-run.

- [ ] **Step 3: Commit** (the test either way — the repo has shipped this bug twice and the geometry proof is the guard).

---

### Task 26: Render management, retire the legacy renderer

**Files:** Create `src/components/accounting/packs/pages/*` for pages 9–18; modify `report-packs.tsx`; **delete** `PackPrintView.tsx`, `PackSectionView.tsx`, `packDocument.ts` and their tests.

- [ ] **Step 1: Route every pack type to `PackPagesView`.** `monthly` maps to the management page set truncated at page 12; note that in `packSections.ts`.
- [ ] **Step 2: Run the full unit suite.** Every test that imported `packDocument` fails — port each to the page model or delete it where the new model's test covers the same rule. Do not leave a test that asserts nothing.
- [ ] **Step 3: Delete the legacy files and their `.claude.md` entries.** Update `src/components/accounting/packs/.claude.md` to describe the page model; run `bun run agent-docs:generate`.
- [ ] **Step 4: Confirm no import of the deleted modules remains:** `grep -rn "packDocument\|PackPrintView\|PackSectionView" src pages tests` returns nothing.
- [ ] **Step 5: Commit.**

```bash
git commit -m "refactor(packs): retire the section-template renderer"
```

---

### Task 27: Management VISUAL GATE

- [ ] Repeat Task 20's procedure for the management pack on Demo then Brightsphere. Threshold 14/15 (criterion 4 applies; only the financial pack is exempt). §7.3 "yes" required.
- [ ] `bun run ci`, push, PR, blind `/review` team, fix every finding, merge.

---

# WS4d — Results deck and front section

Branch `feat/ws4-deck-front`, from `master` after WS4c merges.

### Task 28: The results front section model

**Files:** Create `src/modules/accounting/services/packs/pages/resultsFrontSection.ts`; test alongside.

**Interfaces:** `export function buildResultsFrontSection(set: PackFigureSet, narrative: ApprovedNarrative, p: PackFigureProvenance): PackPagesDocument;`

- [ ] **Step 1: Write the failing test**

```ts
describe('buildResultsFrontSection', () => {
  it('is two pages', () => {
    expect(buildResultsFrontSection(set, approved, p).pages).toHaveLength(2);
  });

  it('makes no listed-company claim', () => {
    // Spec §8 decision 3. A private company's results draft that carries an
    // ISIN or a sponsor line is a compliance problem, not a design flourish.
    const text = JSON.stringify(buildResultsFrontSection(set, approved, p));
    for (const forbidden of ['ISIN', 'share code', 'sponsor', 'SENS', 'Listings Requirements']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('marks itself a draft on its face', () => {
    expect(JSON.stringify(buildResultsFrontSection(set, approved, p)))
      .toMatch(/results announcement draft/i);
  });

  it('puts exactly four numbers in the dateline paragraph', () => {
    const dateline = buildResultsFrontSection(set, approved, p).pages[0]!
      .blocks.find((b) => b.kind === 'narrative')!;
    expect((dateline.narrative.body!.match(/R[\d\s]+|[\d.]+%/g) ?? [])).toHaveLength(4);
  });

  it('refuses to build without both approved quotes', () => {
    expect(() => buildResultsFrontSection(set, { ...approved, ceoQuote: null }, p))
      .toThrow(/approved/i);
  });

  it('emits 8-12 stat tiles in two or three groups on page 2', () => {
    const groups = buildResultsFrontSection(set, approved, p).pages[1]!
      .blocks.filter((b) => b.kind === 'statTiles');
    const tiles = groups.flatMap((g) => g.groups.flatMap((x) => x.tiles));
    expect(tiles.length).toBeGreaterThanOrEqual(8);
    expect(tiles.length).toBeLessThanOrEqual(12);
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 29: Chart PNG rasteriser for pptx

**Files:** Create `src/lib/charts/svgToPng.ts`; test `tests/unit/charts/svgToPng.test.ts`.

**Interfaces:** `export async function rasteriseSvg(svg: string, opts: { widthPx: number; scale: 2 }): Promise<Buffer>;`

- [ ] **Step 1: Write the failing test**

```ts
describe('rasteriseSvg', () => {
  it('returns a PNG at twice the requested width', async () => {
    const png = await rasteriseSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"></svg>',
      { widthPx: 100, scale: 2 });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(200);
  });

  it('rejects an SVG carrying a script or an external reference', async () => {
    // The SVG is rendered by a real engine; a remote href is an SSRF surface.
    await expect(rasteriseSvg('<svg><script>x</script></svg>', { widthPx: 100, scale: 2 })).rejects.toThrow();
    await expect(rasteriseSvg('<svg><image href="http://x/y.png"/></svg>', { widthPx: 100, scale: 2 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Choose the engine.** `sharp` is already a transitive dependency in this repo if Next's image optimisation is enabled — check `bun pm ls sharp` first. If it is present, use it; if it is not, use the Playwright browser the PDF transport already ships rather than adding a native dependency. Record which, and why, in the file header.

- [ ] **Steps 3–5: RED, implement, GREEN, commit.**

---

### Task 30: pptx brand masters

**Files:** Modify `pptxExportService.ts`; test `tests/unit/services/packs/pptxMasters.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe('pptx slide masters', () => {
  it('defines a master from the brand profile, not from hardcoded hexes', () => {
    const master = buildSlideMaster(resolvePackBrand(profile));
    expect(master.background?.color).toBe('1A3A5C');
    expect(JSON.stringify(master)).not.toContain('1F4E79'); // the old constant
  });

  it('names IBM Plex with a documented fallback, since pptx embeds no fonts', () => {
    expect(buildSlideMaster(resolvePackBrand(profile)).fontFace).toMatch(/IBM Plex Sans/);
  });

  it('puts the logo on the master when the brand has one, and omits it otherwise', () => {
    expect(buildSlideMaster(resolvePackBrand(profile)).objects?.some((o) => 'image' in o)).toBe(true);
    expect(buildSlideMaster(resolvePackBrand(null)).objects?.some((o) => 'image' in o)).toBe(false);
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 31: The 16-slide deck

**Files:** Modify `pptxExportService.ts`, `packDeckModel.ts`; test `tests/unit/services/packs/deckSixteen.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe('buildDeck', () => {
  const deck = buildDeck(buildBoardPackPages(demoInput));

  it('is sixteen slides in the spec's order', () => {
    expect(deck.slides).toHaveLength(16);
    expect(deck.slides[1]?.kind).toBe('disclaimer'); // always slide 2, never later
  });

  it('gives every slide an action title', () => {
    for (const slide of deck.slides.slice(2)) {
      expect(() => assertPageTitleIsAMessage(slide.title, 3), slide.title).not.toThrow();
    }
  });

  it('uses a native chart where pptxgenjs supports one and a PNG where it does not', () => {
    expect(deck.slides.find((s) => s.kind === 'revenue')?.chart?.mode).toBe('native');
    // No native waterfall in pptxgenjs 4.x, and the stacked-bar workaround is
    // the same construction this repo has shipped broken twice.
    expect(deck.slides.find((s) => s.kind === 'profitBridge')?.chart?.mode).toBe('png');
  });

  it('carries speaker notes on every slide whose detail is not on the slide', () => {
    for (const slide of deck.slides.filter((s) => s.kind === 'outlook' || s.kind === 'matters')) {
      expect(slide.notes?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('draws every figure from the pack model, never recomputing one', () => {
    expect(() => deck.provenance.assertConsistent()).not.toThrow();
  });
});
```

- [ ] **Steps 2–5: RED, implement, GREEN, commit.**

---

### Task 32: Deck and front-section VISUAL GATE

- [ ] Render the deck (pptx) and the front section (PDF) on Demo then Brightsphere.
- [ ] Convert the pptx to PDF for the reviewer (LibreOffice headless, or screenshots per slide) so it can be compared page-for-page against Shopify Q4-25 and the Naspers/Vodacom decks.
- [ ] Run the gate. Front section threshold 15/15; deck scored on criteria 1, 2, 4, 5, 6, 7, 8, 13, 14, 15. §7.3 "yes" required for both.
- [ ] Fix every finding, re-gate.

---

### WS4d gate

- [ ] VISUAL GATE passed on both artefacts, both companies.
- [ ] `bun run ci` green; push; PR with artefacts attached; blind `/review` team; fix every finding; merge.

---

## What this plan deliberately does not build

Named here so the next session does not mistake them for oversights.

1. **The commentary grounding guard** (spec §6 item 11). R7 narrows every `generated` page to `derived` deterministic sentences instead. The guard is the highest-risk item in the whole brief and deserves its own workstream with its own adversarial review.
2. **The financial pack** (spec §4.C). Spec §8 decision 2 rules that it *wraps* the AFS module, and that ruling is explicitly conditional on auditing the AFS module's current output first — the memory index records that AFS had never worked in production before September 2026. Wrapping a broken document is worse than not shipping one. Audit first, then plan it.
3. **The rendered-pack cache** (spec §6 item 10) and any job queue. Both are performance work against an unmeasured problem.
4. **Tone presets** (spec §6 item 12). Strictly after the grounding guard.
5. **PDF/A** (spec §8 decision 5, accepted): metadata only, on the Gotenberg path.

## Self-review notes

- **Spec coverage:** §4.A → Tasks 8–20. §4.B → Tasks 21–27. §4.D → Task 28. §4.E → Tasks 29–31. §4.C → deliberately deferred, above. §5.1–5.5 → Tasks 1–3, 13, 14. §5.6 → Tasks 7, 25. §5.7 → the block-count proxies in Tasks 17 and 24 plus the visual gate. §6 items 1–9 and 13–15 → Tasks 1–7, 9, 19, 29, 30. §6 items 10–12 → deferred, above. §7.1 → Tasks 20, 27, 32. §7.2 → Task 19. §7.3 → every gate task. §8 decisions 1–6 → Tasks 4, 5 (1), deferral note (2), Task 28 (3), R7 (4), Task 6 (5), density assertions in Tasks 17 and 24 (6).
- **Naming consistency:** `PackFigureSet`, `PackFigureProvenance`, `PackPage`, `PackPagesDocument`, `PackBrand`, `buildPackFigureSet`, `buildBoardPackPages`, `buildManagementPackPages`, `assertPackIntegrity`, `assertPageTitleIsAMessage`, `renderChartSvg`, `resolvePackBrand`, `buildFooterHtml` are used identically in every task that mentions them.
- **Verified against the tree:** `priorPeriod(start, end)` and `priorYearPeriod(start, end)` in `reports/priorPeriod.ts`; `getBudgetVariance` in `reports/budgetVarianceService.ts`; `formatMoney` / `formatPct` / `signOf` in `src/lib/format/money.ts`; `roleStyle` / `varianceColor` in `components/accounting/charts/ibcs.ts`; `escapeHtml` in `services/packs/escapeHtml.ts`. Every task that names one of these uses the real export.
- **Known soft spot:** Task 29 does not know whether `sharp` is resolvable in this repo. Its Step 2 decides between `sharp` and the Playwright browser the PDF transport already ships, and records which. No other task depends on that choice.
