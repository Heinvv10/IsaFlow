/**
 * Task 13: KPI tile, comparative table, and footnote primitives.
 *
 * Two deliberate corrections to the brief's verbatim fixtures, both proven
 * out with the real interfaces rather than guessed:
 *
 * 1. `PackTableRow` (packPageModel.ts, Task 10) carries its per-column
 *    figures nested under `figures: Partial<Record<PackTableColumnKey,
 *    PackFigure>>` — the brief's fixture put `actual`/`prior` directly on
 *    the row. Fixed to the real shape; tsconfig excludes tests/** from
 *    typecheck so the mismatch would not have failed any gate, only made
 *    every table test pass against a shape ComparativeTable never receives
 *    in the real pipeline.
 * 2. `PackKpiTile.sparklineSvg` is `TrustedChartSvg | null`, brand-checked at
 *    construction by `renderChartSvg` — the brief's fixture used a raw
 *    `'<svg></svg>'` string literal, exactly the forged-cast shortcut the
 *    task brief's own security section forbids. Fixed to call the real
 *    `renderChartSvg`, same pattern already used in packPagesView.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComparativeTable } from '@/components/accounting/packs/primitives/ComparativeTable';
import { KpiTileWithSparkline } from '@/components/accounting/packs/primitives/KpiTileWithSparkline';
import { FootnoteMarker } from '@/components/accounting/packs/primitives/FootnoteMarker';
import { FootnoteList } from '@/components/accounting/packs/primitives/FootnoteList';
import { renderChartSvg } from '@/lib/charts/ssrSvg';
import type { PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';
import { ScorecardTable } from '@/components/accounting/packs/primitives/ScorecardTable';

const sparklineSvg = renderChartSvg({}, { widthMm: 10, heightMm: 10 });

describe('KpiTileWithSparkline', () => {
  const tile = {
    label: 'Revenue', figure: { value: 1_120_000, format: 'money' as const, source: 's.revenue' },
    delta: { value: 12, basis: 'vs prior period', favourable: true },
    deltaAbsence: null,
    trendFootnote: 1, sparklineSvg,
  };

  it('states the basis of the delta beside it', () => {
    render(<KpiTileWithSparkline scale="R" tile={tile} />);
    // A delta with no stated basis is the "up 12%… against what?" failure.
    expect(screen.getByText(/vs prior period/)).toBeInTheDocument();
  });

  it('carries a shape cue alongside the variance colour', () => {
    const { container } = render(<KpiTileWithSparkline scale="R" tile={tile} />);
    // Rubric criterion 7: colour alone fails a deuteranopic reader.
    expect(container.querySelector('[data-variance-cue]')).not.toBeNull();
  });

  it('renders the unavailable reason instead of a figure, never 0', () => {
    render(<KpiTileWithSparkline scale="R" tile={{ ...tile,
      figure: { value: null, format: 'pct', source: 'r.roe', unavailable: 'Equity is not positive' } }} />);
    expect(screen.getByText('Equity is not positive')).toBeInTheDocument();
    expect(screen.queryByText('0.0%')).toBeNull();
  });

  it('omits the delta entirely when there is no comparative', () => {
    render(<KpiTileWithSparkline scale="R" tile={{ ...tile, delta: null }} />);
    expect(screen.queryByText(/vs prior/)).toBeNull();
  });

  it('renders the trusted sparkline markup via the sink, unmodified', () => {
    const { container } = render(<KpiTileWithSparkline scale="R" tile={tile} />);
    expect(container.querySelector('.pack-kpi-sparkline svg')).not.toBeNull();
  });

  it('renders no sparkline element when there is no series', () => {
    const { container } = render(<KpiTileWithSparkline scale="R" tile={{ ...tile, sparklineSvg: null }} />);
    expect(container.querySelector('.pack-kpi-sparkline')).toBeNull();
  });
});

describe('ComparativeTable', () => {
  const table: PackTable = {
    scale: "R'000", columns: ['actual', 'prior', 'change', 'changePct'],
    rows: [
      { label: 'Revenue', level: 0, role: 'line',
        figures: {
          actual: { value: 1_120_000, format: 'money', source: 's.revenue' },
          prior: { value: 1_000_000, format: 'money', source: 's.priorRevenue' },
        } },
      { label: 'Gross profit', level: 0, role: 'subtotal',
        figures: {
          actual: { value: 400_000, format: 'money', source: 's.gp' },
          prior: { value: 350_000, format: 'money', source: 's.priorGp' },
        } },
    ],
  };

  it('states the scale once, in the header', () => {
    render(<ComparativeTable scale="R" table={table} />);
    expect(within(screen.getByRole('table')).getByText(/R'000/)).toBeInTheDocument();
  });

  it('prints a negative in parentheses and a zero as an en dash', () => {
    render(<ComparativeTable scale="R" table={{ ...table, rows: [
      { label: 'Loss', level: 0, role: 'line',
        figures: {
          actual: { value: -1_000, format: 'money', source: 's.x' },
          prior: { value: 0, format: 'money', source: 's.y' },
        } },
    ] }} />);
    expect(screen.getByText(/\(1 000\)/)).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument();
  });

  /**
   * A DASH IS A NIL AND AN n/m ROW HAS NO NILS IN IT.
   *
   * The cash page printed the same en dash `formatMoney` uses for a measured
   * zero into the prior, change and change-% cells of three rows whose actual
   * is n/m because nothing was captured — so a director adding the change
   * column read "no movement" for three measures with no value at all.
   */
  it('prints n/m, not a dash, in the derived cells of a not-meaningful row', () => {
    render(<ComparativeTable scale="R" table={{ ...table, rows: [
      { label: 'Operating cash flow', level: 0, role: 'line',
        figures: {
          actual: { value: null, format: 'money', source: 's.ocf',
            unavailable: 'No cash flow statement has been captured for the period.' },
        } },
      // A row that DOES have figures keeps the columns on the table.
      { label: 'Cash', level: 0, role: 'line',
        figures: {
          actual: { value: 100, format: 'money', source: 's.cash' },
          prior: { value: 0, format: 'money', source: 's.priorCash' },
          change: { value: 100, format: 'money', source: 's.cashChange' },
          changePct: { value: 100, format: 'pct', source: 's.cashChangePct' },
        } },
    ] }} />);
    const row = screen.getByText('Operating cash flow').closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).queryByText('–')).toBeNull();
    expect(within(row!).getAllByText(/n\/m/).length).toBe(4);
  });

  it('drops the prior and change columns when no row has a prior', () => {
    // Not a column of dashes: an absent comparative is an absent column.
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: table.rows.map(
      (r) => ({ ...r, figures: { actual: r.figures.actual } }),
    ) }} />);
    expect(container.querySelectorAll('thead th')).toHaveLength(2);
  });

  it('marks subtotal and total rows for the rule styling', () => {
    const { container } = render(<ComparativeTable scale="R" table={table} />);
    expect(container.querySelector('tr.is-subtotal')).not.toBeNull();
  });

  it('renders a repeating header group so a long table paginates', () => {
    const { container } = render(<ComparativeTable scale="R" table={table} />);
    expect(container.querySelector('thead')).not.toBeNull();
  });

  it('marks a grand total row for the double-rule styling', () => {
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: [
      ...table.rows,
      { label: 'Net profit', level: 0, role: 'grandTotal',
        figures: { actual: { value: 500_000, format: 'money', source: 's.np' } } },
    ] }} />);
    expect(container.querySelector('tr.is-grand-total')).not.toBeNull();
  });

  it('indents a level-2 row further than a level-0 row', () => {
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: [
      { label: 'Section', level: 0, role: 'line', figures: { actual: table.rows[0]!.figures.actual } },
      { label: 'Sub-account', level: 2, role: 'line', figures: { actual: table.rows[0]!.figures.actual } },
    ] }} />);
    const cells = container.querySelectorAll('tbody td:first-child');
    const level0Indent = parseFloat((cells[0] as HTMLElement).style.paddingLeft);
    const level2Indent = parseFloat((cells[1] as HTMLElement).style.paddingLeft);
    expect(level2Indent).toBeGreaterThan(level0Indent);
  });

  it('renders the unavailable reason for a null figure, never a formatted zero', () => {
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: [
      ...table.rows,
      { label: 'Return on equity', level: 0, role: 'line',
        figures: { actual: { value: null, format: 'pct', source: 'r.roe', unavailable: 'Equity is not positive' } } },
    ] }} />);
    // The reason is printed in FULL, once, as a note under the table, and the
    // cell carries the mark that points at it. In the cell itself it was a
    // three-line paragraph in a numeric column, repeated on every row that
    // shared the reason, and that is what pushed four statement pages onto a
    // second sheet each. Nothing is summarised: the sentence is still here.
    expect(screen.getByText(/Equity is not positive/)).toBeInTheDocument();
    expect(container.querySelector('.pack-table-notes')).not.toBeNull();
    const cells = [...container.querySelectorAll('tbody tr:last-child td')].map((td) => td.textContent);
    expect(cells[1]).toBe('n/ma');
    // And never a formatted zero, which is what the reason exists to prevent.
    expect(cells[1]).not.toBe('0.0%');
  });

  // Spec §5.5: zebra banding applies only once a table EXCEEDS 12 rows. Both
  // sides of the boundary are pinned separately — a single test above the
  // line would pass equally against an always-emit implementation.
  const rowsOf = (count: number) => Array.from({ length: count }, (_, i) => ({
    label: `Line ${i}`, level: 0 as const, role: 'line' as const,
    figures: { actual: { value: 1, format: 'money' as const, source: `s.line${i}` } },
  }));

  it('does not band a table at exactly the 12-row threshold', () => {
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: rowsOf(12) }} />);
    expect(container.querySelector('table')?.className).not.toMatch(/is-long/);
  });

  it('bands a table of 13 rows, one past the threshold', () => {
    const { container } = render(<ComparativeTable scale="R" table={{ ...table, rows: rowsOf(13) }} />);
    expect(container.querySelector('table')?.className).toMatch(/is-long/);
  });
});

describe('FootnoteMarker', () => {
  it('renders the footnote number as a superscript reference', () => {
    render(<FootnoteMarker number={2} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('renders nothing when there is no footnote to point at', () => {
    const { container } = render(<FootnoteMarker number={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('FootnoteList', () => {
  it('renders every footnote, numbered', () => {
    render(<FootnoteList footnotes={[{ number: 1, text: 'First note' }, { number: 2, text: 'Second note' }]} />);
    expect(screen.getByText('First note')).toBeInTheDocument();
    expect(screen.getByText('Second note')).toBeInTheDocument();
  });

  // THE LABEL IS THE HALF THE MARKER POINTS AT. The test above asserted only
  // the prose and passed while the list printed no numbers at all: Tailwind
  // preflight strips the `<ol>` marker app-wide, so sheet 3's `Revenue¹`
  // referenced an unlabelled grey block. Asserted on the rendered element
  // rather than the `<ol>` type, because the type is what was already true.
  it('prints each footnote label, so an inline marker resolves to it', () => {
    const { container } = render(
      <FootnoteList footnotes={[{ number: 1, text: 'First note' }, { number: 2, text: 'Second note' }]} />,
    );
    const labels = Array.from(container.querySelectorAll('.pack-footnote-number')).map((n) => n.textContent);
    expect(labels).toEqual(['1', '2']);
  });

  it('renders nothing for an empty list', () => {
    const { container } = render(<FootnoteList footnotes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});


/**
 * The scale, THROUGH THE RENDERER.
 *
 * The service-side assertion for this hands `formatFigureText` the scale
 * itself, so it proves the formatter works and nothing about whether the
 * component passes one. Every primitive called `formatFigureText(figure)`
 * with no scale while `ComparativeTable` printed "R'000" as its caption
 * directly above — the header and the cells disagreed by a factor of a
 * thousand, and no assertion read one against the other in the DOM.
 */
describe('a rendered cell agrees with the header above it', () => {
  const thousands: PackTable = {
    scale: "R'000",
    columns: ['actual'],
    rows: [{
      label: 'Revenue',
      level: 0,
      role: 'line',
      figures: { actual: { value: 4_200_000, format: 'money', source: 'test.revenue' } },
    }],
  };

  it('prints a thousands figure under a thousands caption', () => {
    const { container } = render(<ComparativeTable table={thousands} scale="R'000" />);
    expect(container.querySelector('caption')?.textContent).toBe("R'000");
    expect(container.querySelector('tbody td:nth-child(2)')?.textContent).toBe('4 200');
  });

  it('scales the scorecard target with the actual it is a goal for', () => {
    // The target column is what a reader uses to judge whether the actual
    // passed; an unscaled target beside a scaled actual is the comparison
    // itself being wrong, not just a cell.
    const groups = [{
      letter: 'A',
      name: 'Profitability',
      rows: [{
        metric: 'Operating profit',
        actual: { value: 4_200_000, format: 'money' as const, source: 'test.op' },
        target: 3_000_000,
        prior: null,
        status: 'met' as const,
        trend: null,
        trendSvg: null,
        bulletSvg: null,
      }],
    }];
    const { container } = render(<ScorecardTable groups={groups} scale="R'000" />);
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells).toContain('4 200');
    expect(cells).toContain('3 000');
  });
});
