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

const sparklineSvg = renderChartSvg({}, { widthMm: 10, heightMm: 10 });

describe('KpiTileWithSparkline', () => {
  const tile = {
    label: 'Revenue', figure: { value: 1_120_000, format: 'money' as const, source: 's.revenue' },
    delta: { value: 12, basis: 'vs prior period', favourable: true },
    trendFootnote: 1, sparklineSvg,
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

  it('renders the trusted sparkline markup via the sink, unmodified', () => {
    const { container } = render(<KpiTileWithSparkline tile={tile} />);
    expect(container.querySelector('.pack-kpi-sparkline svg')).not.toBeNull();
  });

  it('renders no sparkline element when there is no series', () => {
    const { container } = render(<KpiTileWithSparkline tile={{ ...tile, sparklineSvg: null }} />);
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
    render(<ComparativeTable table={table} />);
    expect(within(screen.getByRole('table')).getByText(/R'000/)).toBeInTheDocument();
  });

  it('prints a negative in parentheses and a zero as an en dash', () => {
    render(<ComparativeTable table={{ ...table, rows: [
      { label: 'Loss', level: 0, role: 'line',
        figures: {
          actual: { value: -1_000, format: 'money', source: 's.x' },
          prior: { value: 0, format: 'money', source: 's.y' },
        } },
    ] }} />);
    expect(screen.getByText(/\(1 000\)/)).toBeInTheDocument();
    expect(screen.getByText('–')).toBeInTheDocument();
  });

  it('drops the prior and change columns when no row has a prior', () => {
    // Not a column of dashes: an absent comparative is an absent column.
    const { container } = render(<ComparativeTable table={{ ...table, rows: table.rows.map(
      (r) => ({ ...r, figures: { actual: r.figures.actual } }),
    ) }} />);
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

  it('marks a grand total row for the double-rule styling', () => {
    const { container } = render(<ComparativeTable table={{ ...table, rows: [
      ...table.rows,
      { label: 'Net profit', level: 0, role: 'grandTotal',
        figures: { actual: { value: 500_000, format: 'money', source: 's.np' } } },
    ] }} />);
    expect(container.querySelector('tr.is-grand-total')).not.toBeNull();
  });

  it('indents a level-2 row further than a level-0 row', () => {
    const { container } = render(<ComparativeTable table={{ ...table, rows: [
      { label: 'Section', level: 0, role: 'line', figures: { actual: table.rows[0]!.figures.actual } },
      { label: 'Sub-account', level: 2, role: 'line', figures: { actual: table.rows[0]!.figures.actual } },
    ] }} />);
    const cells = container.querySelectorAll('tbody td:first-child');
    const level0Indent = parseFloat((cells[0] as HTMLElement).style.paddingLeft);
    const level2Indent = parseFloat((cells[1] as HTMLElement).style.paddingLeft);
    expect(level2Indent).toBeGreaterThan(level0Indent);
  });

  it('renders the unavailable reason for a null figure, never a formatted zero', () => {
    render(<ComparativeTable table={{ ...table, rows: [
      ...table.rows,
      { label: 'Return on equity', level: 0, role: 'line',
        figures: { actual: { value: null, format: 'pct', source: 'r.roe', unavailable: 'Equity is not positive' } } },
    ] }} />);
    expect(screen.getByText('Equity is not positive')).toBeInTheDocument();
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

  it('renders nothing for an empty list', () => {
    const { container } = render(<FootnoteList footnotes={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
