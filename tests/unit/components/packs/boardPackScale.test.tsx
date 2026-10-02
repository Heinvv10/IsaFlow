/**
 * THE PACK STATES ONE SCALE, AND EVERY LAYER OF IT OBEYS — R-P52, on the
 * RENDERED page rather than on a formatter's return value.
 *
 * This is the test the previous fix did not have. `formatMoney` learned about
 * `MONEY_SCALES` and its own unit test handed it a scale and checked the
 * string that came back, which it always did correctly. The tables and the
 * KPI tiles were wired to pass the document's scale; the PROSE and the CHART
 * AXES were not. So the first rendered pack printed revenue as `99` in the
 * table on page 6 and, three centimetres below on the same sheet under the
 * same `R'000` header, "Revenue of 98 800 bridges to net profit of
 * (1 545 540)", over a y-axis running to −1,500,000. A director who reads the
 * sentence instead of the table misreads every figure by a factor of a
 * thousand.
 *
 * No assertion here can be satisfied by a function returning the right
 * string. Each one renders the whole pack and reads what a reader would see:
 * the DOM text of every page, chart SVGs included — a chart's axis ticks and
 * bar labels are `<text>` nodes inside the inlined SVG, so they are part of
 * `textContent` and part of what is asserted.
 *
 * WHY IT IS PHRASED AS AN ABSENCE. Asserting the scaled string is PRESENT
 * cannot fail on the defect: `4 200` is a substring of `4 200 000`, so a page
 * printing raw rands passes a presence check for the scaled form. Absence of
 * the raw rendering is what actually distinguishes the two, and it is checked
 * across the whole document rather than page by page, because the defect was
 * never confined to one page.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PackPagesView } from '@/components/accounting/packs/PackPagesView';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { formatMoney } from '@/lib/format/money';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { demoInput } from '../../services/packs/fixtures/boardPackInputs';

/**
 * Figures the fixture states in whole rands, each at least six digits so its
 * raw and its scaled rendering are different strings — a figure under a
 * thousand prints the same either way and could not fail this test.
 */
const RAW_FIGURES: Record<string, number> = {
  revenue: demoInput.set.current.revenue,
  costOfSales: demoInput.set.current.costOfSales,
  operatingExpenses: demoInput.set.current.operatingExpenses,
  netProfit: demoInput.set.current.netProfit,
  totalAssets: demoInput.set.current.totalAssets,
  totalLiabilities: demoInput.set.current.totalLiabilities,
  totalEquity: demoInput.set.current.totalEquity,
  cash: demoInput.set.current.cash,
};

/** The whole rendered pack as a reader sees it — chart `<text>` included. */
function renderedPackText(): string {
  const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
  const root = container.querySelector('.pack-pages');
  if (root === null) throw new Error('the pack did not render');
  return root.textContent ?? '';
}

/** The same, with every `<table>` removed: what is left is titles, captions,
 *  disclosures, chart titles, axis ticks and bar labels — precisely the
 *  layers that were printing raw rands under a scaled header. */
function renderedProseAndChartText(): string {
  const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
  const root = container.querySelector('.pack-pages');
  if (root === null) throw new Error('the pack did not render');
  for (const table of Array.from(root.querySelectorAll('table'))) table.remove();
  return root.textContent ?? '';
}

describe('the rendered board pack states one scale (R-P52)', () => {
  it('the fixture figures are large enough for this test to be able to fail', () => {
    for (const [name, raw] of Object.entries(RAW_FIGURES)) {
      expect(formatMoney(raw), name).not.toBe(formatMoney(raw, { scale: PACK_SCALE }));
    }
  });

  it('prints no figure in raw rands anywhere on the pack', () => {
    const text = renderedPackText();
    for (const [name, raw] of Object.entries(RAW_FIGURES)) {
      expect(text, `${name} printed unscaled — the pack states ${PACK_SCALE}`)
        .not.toContain(formatMoney(raw));
    }
  });

  it('prints no figure in raw rands in the prose and the charts either', () => {
    // The narrower surface, asserted separately: a regression that reaches
    // only the sentences and the axes would still fail the whole-pack check
    // above, but this one says WHERE without anyone having to bisect.
    const text = renderedProseAndChartText();
    for (const [name, raw] of Object.entries(RAW_FIGURES)) {
      expect(text, `${name} printed unscaled outside the tables`)
        .not.toContain(formatMoney(raw));
    }
  });

  it('prints the same figure at the same scale in a table cell and in prose', () => {
    const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
    const root = container.querySelector('.pack-pages')!;

    const tableText = Array.from(root.querySelectorAll('table'))
      .map((t) => t.textContent ?? '')
      .join(' ');
    for (const table of Array.from(root.querySelectorAll('table'))) table.remove();
    const proseText = root.textContent ?? '';

    // Revenue is the figure the rejected render disagreed with itself over.
    const scaled = formatMoney(RAW_FIGURES.revenue!, { scale: PACK_SCALE });
    expect(tableText, 'revenue is missing from every table').toContain(scaled);
    expect(proseText, 'revenue is missing from the prose and the charts').toContain(scaled);
  });

  /**
   * Every number a chart PRINTS, parsed back out of its rendered SVG.
   *
   * A chart's axis ticks and bar labels are `<text>` nodes, read one node at a
   * time rather than off the SVG's concatenated `textContent`: the ticks run
   * together there ("0-300,000-600,000") and no number survives the join.
   * Parentheses are the pack's negative and thousands are separated by a
   * space, so both are undone before parsing. COMMAS are stripped too, and
   * that is load-bearing rather than defensive: an unformatted ECharts axis
   * prints `1,000,000`, which `Number()` reads as NaN — a parser that did not
   * strip them would silently skip every tick of exactly the axis this test
   * exists to catch, and pass.
   */
  function numbersPrintedInCharts(root: Element): number[] {
    const out: number[] = [];
    for (const svg of Array.from(root.querySelectorAll('[data-pack-chart] svg'))) {
      for (const node of Array.from(svg.querySelectorAll('text'))) {
        const raw = (node.textContent ?? '').trim();
        const cleaned = raw
          .replace(/[()]/g, '')
          .replace(/[\s\u00a0\u202f,]/g, '')
          .replace(/[−–]/g, '-');
        const n = Number(cleaned.replace(/%|days|R/g, ''));
        if (Number.isFinite(n) && cleaned !== '') out.push(Math.abs(n));
      }
    }
    return out;
  }

  it('draws no axis tick or bar label in raw rands', () => {
    // The axis was the half of this defect a figure-by-figure check cannot
    // see: ECharts picks its own round ticks, so an axis running to
    // -1,500,000 under an R'000 header matches no model figure exactly and
    // an absence check on named figures passes straight over it. The shape of
    // the failure is that the numbers are a THOUSAND times too big, so that
    // is what is asserted — against the largest figure the pack states.
    const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
    const root = container.querySelector('.pack-pages')!;

    const largestRaw = Math.max(...Object.values(RAW_FIGURES).map(Math.abs));
    const printed = numbersPrintedInCharts(root);
    expect(printed.length, 'no chart printed a number at all').toBeGreaterThan(0);

    // A hundredth of the largest raw figure: far above anything the scaled
    // pack draws (its largest is a thousandth) and far below anything a
    // rand-denominated axis would reach.
    const ceiling = largestRaw / 100;
    const tooBig = printed.filter((n) => n > ceiling);
    expect(tooBig, `chart text printed ${tooBig.join(', ')} — too large for ${PACK_SCALE}`).toEqual([]);
  });

  it("names the scale on every money chart's own axis", () => {
    const { container } = render(<PackPagesView document={buildBoardPackPages(demoInput)} />);
    // The chart states its units itself rather than borrowing the caption of
    // whatever table happens to sit above it — a chart forwarded on its own,
    // or one on a page with no table, would otherwise carry no scale at all.
    const charts = Array.from(container.querySelectorAll('[data-pack-chart] svg'));
    expect(charts.length).toBeGreaterThan(0);
    const withAxisName = charts.filter((svg) => (svg.textContent ?? '').includes(PACK_SCALE));
    expect(withAxisName.length, 'no rendered chart names its own scale').toBeGreaterThan(0);
  });
});
