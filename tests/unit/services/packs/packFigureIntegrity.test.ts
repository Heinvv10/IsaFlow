/**
 * The gate that refuses to render a pack whose figures do not reconcile.
 *
 * WHAT EACH FIXTURE MAKES REACHABLE is the thing to read for here. A pack
 * built from the healthy demo input is already correct, so it can only ever
 * prove the gate ACCEPTS — it cannot reach a single rejection branch. And a
 * gate that threw on everything would pass every `.toThrow()` test in this
 * file. So each rejection below is pinned by its own acceptance case: the same
 * shape, one figure moved, expected NOT to throw. A test that only asserts the
 * throw proves the branch is reachable, not that it discriminates.
 *
 * The hand-built documents are the real demo document with `pages` and
 * `provenance` replaced. The BRIDGE cases live in
 * `packWaterfallIntegrity.test.ts`, and the ones that need the real composer
 * in `packIntegrityAtCompose.test.ts` — the same seams the implementation
 * uses, so a check and the tests that drive it stay next to each other.
 */
import { describe, expect, it } from 'vitest';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import {
  PackFigureProvenance,
  type PackFigure,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type {
  PackComparativePeriod,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
  PackTable,
  PackTableColumnKey,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereInput, demoInput } from './fixtures/boardPackInputs';

const template = buildBoardPackPages(demoInput);

/** The three totals every pack must record, at values that foot. Overriding
 *  one is how the balance-sheet branch is reached. */
function balanced(
  p: PackFigureProvenance,
  totals: { assets?: number; liabilities?: number; equity?: number } = {},
): void {
  p.figure('packFigureSet.current.totalAssets', totals.assets ?? 3_900_000, 'money');
  p.figure('packFigureSet.current.totalLiabilities', totals.liabilities ?? 1_640_000, 'money');
  p.figure('packFigureSet.current.totalEquity', totals.equity ?? 2_260_000, 'money');
}

function page(blocks: PackPageBlock[]): PackPage {
  return { number: 7, title: 'Cash rose to 610', section: 'Financials', orientation: 'portrait', density: 'high', blocks, footnotes: [] };
}

/**
 * A hand-built document. `comparativePeriod` defaults to NULL because the
 * pages built here carry no comparative column — a document claiming a
 * comparative period nothing compares against is itself a failure (R-P55), so
 * inheriting the demo pack's period would make every case below fail for a
 * reason it is not testing.
 */
function docOf(
  p: PackFigureProvenance,
  blocks: PackPageBlock[] = [],
  comparativePeriod: PackComparativePeriod | null = null,
): PackPagesDocument {
  return { ...template, provenance: p, pages: [page(blocks)], comparativePeriod };
}

const tile = (label: string, figure: PackFigure): PackPageBlock => ({
  kind: 'kpiTiles',
  tiles: [{ label, figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }],
});

function tableOf(columns: PackTableColumnKey[], figures: PackTable['rows'][number]['figures']): PackPageBlock {
  return {
    kind: 'table',
    table: { scale: "R'000", columns, rows: [{ label: 'Revenue', level: 0, role: 'line', figures }] },
  };
}

describe('assertPackIntegrity', () => {
  it('passes a well-formed pack', () => {
    expect(() => assertPackIntegrity(buildBoardPackPages(demoInput))).not.toThrow();
  });

  it('passes the pack with no prior period, negative equity and no budget', () => {
    // Brightsphere reaches every absent-comparative and not-meaningful branch
    // the demo pack cannot. If the gate mistook an honest absence for a
    // failure, this is where it would show.
    expect(() => assertPackIntegrity(buildBoardPackPages(brightsphereInput))).not.toThrow();
  });

  it('refuses a pack that never recorded the balance-sheet totals at all', () => {
    // The quietest false green: a gate that skips a missing figure passes a
    // pack it never checked.
    expect(() => assertPackIntegrity(docOf(new PackFigureProvenance())))
      .toThrow(/never recorded/i);
  });

  it('fails when the same figure appears twice with different rounding', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    p.figure('packFigureSet.current.revenue', 1_000_000.4, 'money');
    expect(() => assertPackIntegrity(docOf(p))).toThrow(/disagree/i);
  });

  it('accepts the same figure issued twice at the same value', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    p.figure('packFigureSet.current.revenue', 1_000_000, 'money');
    expect(() => assertPackIntegrity(docOf(p))).not.toThrow();
  });

  it('fails when a percentage does not recompute from its stated numerator and denominator', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const figure = p.figure('marginPct.grossMargin', 45, 'pct', undefined, { numerator: 400, denominator: 1000 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).toThrow(/recompute|does not/i);
  });

  it('accepts a percentage that recomputes', () => {
    const p = new PackFigureProvenance();
    balanced(p);
    const figure = p.figure('marginPct.grossMargin', 40, 'pct', undefined, { numerator: 400, denominator: 1000 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).not.toThrow();
  });

  it('pins the ratio tolerance from both sides', () => {
    // Nothing distinguished 0.005 from 0.01 before this — the tolerance was
    // a number no test held, which is how one gets widened later "because
    // nothing broke". Both bounds are now load-bearing.
    //
    // Below: the engine's double rounding at its worst. 724951/1000000 is
    // 0.724951; `safeDiv` makes it 0.7250 and `r2` prints 0.73, which is
    // 0.005049 away — an HONEST ratio a half-unit tolerance would refuse.
    const honest = new PackFigureProvenance();
    balanced(honest);
    const printed = honest.figure('calculateExtendedRatios.currentRatio', 0.73, 'ratio', undefined, {
      numerator: 724_951,
      denominator: 1_000_000,
    });
    expect(() => assertPackIntegrity(docOf(honest, [tile('Current ratio', printed)]))).not.toThrow();

    // Above: a ratio prints to two decimals, so 0.009 of error shows 0.74
    // where the truth is 0.73. Visible on the page, and refused.
    const wrong = new PackFigureProvenance();
    balanced(wrong);
    const misprinted = wrong.figure('calculateExtendedRatios.currentRatio', 0.74, 'ratio', undefined, {
      numerator: 731,
      denominator: 1_000,
    });
    expect(() => assertPackIntegrity(docOf(wrong, [tile('Current ratio', misprinted)])))
      .toThrow(/does not recompute/);
  });

  it('fails a percentage or ratio that states no numerator and denominator (I-1)', () => {
    // The asymmetry that was the hole: the gate refused a `money` figure
    // CARRYING a basis as unrecomputable, while a ratio carrying none was
    // waved through — so seven live figures, current ratio and cash ratio and
    // debt-to-equity among them, were never recomputed at all. A quotient
    // only got checked if it had already volunteered its working.
    for (const format of ['pct', 'ratio'] as const) {
      const p = new PackFigureProvenance();
      balanced(p);
      const figure = p.figure('calculateExtendedRatios.currentRatio', 1.97, format);
      const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Current ratio', figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }] };
      expect(() => assertPackIntegrity(docOf(p, [block])), format)
        .toThrow(/states no numerator and denominator/i);
    }
  });

  it('does not demand a basis of a figure that is not a quotient', () => {
    // The negative pin, and the reason the rule is scoped to two formats. A
    // day count is a rate times a period length — receivables over revenue
    // times 365 — so there is no numerator-over-denominator to reproduce
    // without inventing a third term, and money is not a quotient at all.
    for (const format of ['money', 'days'] as const) {
      const p = new PackFigureProvenance();
      balanced(p);
      const figure = p.figure('calculateExtendedRatios.debtorDays', 62.6, format);
      const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Debtor days', figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }] };
      expect(() => assertPackIntegrity(docOf(p, [block])), format).not.toThrow();
    }
  });

  it('skips a not-meaningful figure rather than failing it (R-P44)', () => {
    // Both halves of the null path at once: a null gross profit leaves the
    // gross-profit identity nothing to reconcile, and a null margin carrying
    // a basis has no printed percentage to recompute. Neither is a defect —
    // each states its own reason.
    const p = new PackFigureProvenance();
    balanced(p);
    p.figure('packFigureSet.current.revenue', 0, 'money');
    p.figure('packFigureSet.current.costOfSales', 120_000, 'money');
    p.figure('packStatementTables.grossProfit', null, 'money', 'Nothing was captured for this line.');
    const figure = p.figure('marginPct.grossMargin', null, 'pct', 'Revenue is not positive, so there is no turnover to take a margin of.', { numerator: 0, denominator: 0 });
    const block: PackPageBlock = { kind: 'kpiTiles', tiles: [{ label: 'Gross margin', figure, delta: null, deltaAbsence: 'noComparativePeriod', trendFootnote: null, sparklineSvg: null }] };
    expect(() => assertPackIntegrity(docOf(p, [block]))).not.toThrow();
  });

  it('fails a figure printed on a page that no service issued', () => {
    const recorded = new PackFigureProvenance();
    balanced(recorded);
    const other = new PackFigureProvenance();
    const stray = other.figure('packFigureSet.current.revenue', 4_200_000, 'money');
    expect(() => assertPackIntegrity(docOf(recorded, [tableOf(['actual'], { actual: stray })])))
      .toThrow(/no service issued|provenance map/i);
  });

  it('fails a matter whose quantum no service issued (I-4)', () => {
    // Page 11 was the one printed number in the pack that did not resolve
    // through the provenance map, so §7.2's first bullet was not literally
    // true of it. This fails only if the figure walk actually VISITS a
    // matters block.
    const recorded = new PackFigureProvenance();
    balanced(recorded);
    const other = new PackFigureProvenance();
    const stray = other.figure('buildMatters.quantum.0', 244_800, 'money');
    const block: PackPageBlock = {
      kind: 'matters',
      matters: [{
        issue: 'Aged debtor concentration',
        quantum: stray,
        owner: 'Credit control',
        movement: 'Not tracked.',
        decisionRequired: 'Approve escalation.',
      }],
      // Required by `PackPageBlock`, and it was missing: `tests/**` is outside
      // `tsconfig`, so a fixture may omit a required field and neither
      // `tsc --noEmit` nor vitest notices. `locateFigures` now reads it.
      omitted: null,
    };
    expect(() => assertPackIntegrity(docOf(recorded, [block])))
      .toThrow(/no service issued|provenance map/i);
  });

  it('fails the render rather than warning', () => {
    // The whole point. A warning on a document a director forwards to a bank
    // is a warning nobody reads.
    const p = new PackFigureProvenance();
    balanced(p, { equity: 1 });
    expect(assertPackIntegrity).toBeTypeOf('function');
    expect(assertPackIntegrity(buildBoardPackPages(demoInput))).toBeUndefined();
    expect(() => assertPackIntegrity(docOf(p))).toThrow();
  });
});
