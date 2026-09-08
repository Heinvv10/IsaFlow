import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NegativeEquityBlock } from '@/components/accounting/packs/primitives/NegativeEquityBlock';
import { NarrativeColumns } from '@/components/accounting/packs/primitives/NarrativeColumns';
import { ScorecardTable } from '@/components/accounting/packs/primitives/ScorecardTable';
import { renderChartSvg } from '@/lib/charts/ssrSvg';

// The brief's own fixture forged `bulletSvg: '<svg></svg>'` — a plain string,
// not a value that passed `renderChartSvg`'s guards. Same defect class flagged
// twice already in this workstream (packPagesView.test.tsx, primitives.test.tsx);
// fixed the same way here rather than repeated a third time.
const bulletSvg = renderChartSvg({}, { widthMm: 10, heightMm: 4 });

describe('ScorecardTable', () => {
  const groups = [
    { letter: 'A', name: 'Profitability', rows: [
      { metric: 'Gross margin', actual: { value: 35.2, format: 'pct' as const, source: 'r.gm' },
        target: 35, prior: { value: 31, format: 'pct' as const, source: 'r.pgm' },
        status: 'met' as const, bulletSvg },
      { metric: 'Return on equity', actual: { value: null, format: 'pct' as const, source: 'r.roe',
        unavailable: 'Equity is not positive' }, target: 15, prior: null,
        status: 'notMeaningful' as const, footnote: 1, bulletSvg: null },
    ] },
  ];

  it('groups rows under a lettered heading', () => {
    render(<ScorecardTable scale="R" groups={groups} />);
    expect(screen.getByText(/A\.\s*Profitability/)).toBeInTheDocument();
  });

  it('marks a not-meaningful row and states its reason once, under the table', () => {
    const { container } = render(<ScorecardTable scale="R" groups={groups} />);
    // The row's own page footnote marker still prints.
    expect(screen.getByText('1')).toBeInTheDocument();
    // Rubric criterion 9: the explanation belongs in ONE place, not repeated
    // inside every affected cell. The cell carries `n/m` and the mark of the
    // note; the note under the scorecard carries the sentence in full, once.
    const cells = [...container.querySelectorAll('tbody td')].map((td) => td.textContent);
    expect(cells).toContain('n/ma');
    expect(cells.filter((t) => t?.includes('Equity is not positive'))).toHaveLength(0);
    const notes = container.querySelector('.pack-table-notes');
    expect(notes?.textContent).toContain('Equity is not positive');
  });

  it('refuses more than 20 rows', () => {
    const many = [{ letter: 'A', name: 'X', rows: Array.from({ length: 21 }, () => groups[0]!.rows[0]!) }];
    expect(() => render(<ScorecardTable scale="R" groups={many} />)).toThrow(/20/);
  });

  it('refuses more than 5 rows in one group, even when the total is well under 20', () => {
    // 6 rows in one group, nothing else — total is 6, nowhere near the
    // 20-row cap, so only the PER-GROUP check can be what throws here.
    const oneBigGroup = [
      { letter: 'A', name: 'X', rows: Array.from({ length: 6 }, () => groups[0]!.rows[0]!) },
    ];
    expect(() => render(<ScorecardTable scale="R" groups={oneBigGroup} />)).toThrow(/5/);
  });

  it('never infers a direction for a row with no trend and no trendSvg (R-P43)', () => {
    // actual (40) > prior (30) here on purpose — if the component ever
    // derived a direction from actual vs prior, this fixture would produce
    // an 'up' arrow. It must not: trend is null, so the model states it
    // does not know, and the Trend cell must render nothing.
    const noTrendGroups = [{ letter: 'B', name: 'Efficiency', rows: [
      { metric: 'Cash conversion', actual: { value: 40, format: 'days' as const, source: 'r.cc' },
        target: null, prior: { value: 30, format: 'days' as const, source: 'r.pcc' },
        status: 'unscored' as const, trend: null, trendSvg: null, bulletSvg: null },
    ] }];
    const { container } = render(<ScorecardTable scale="R" groups={noTrendGroups} />);
    // No row can fill a Trend cell, so the column is not printed at all —
    // the same data-driven rule `ComparativeTable` applies. A headed column
    // of empty cells reads as data that failed to load rather than as a
    // series the pack does not have. Either way, no direction is inferred,
    // which is what R-P43 is about.
    expect(container.querySelector('.pack-scorecard-trend')).toBeNull();
    const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).not.toContain('Trend');
    expect(container.textContent).not.toMatch(/[▲▼]/);
  });

  it('prints the Trend column when a row actually has one', () => {
    // The other side of the boundary: dropping the column must depend on the
    // DATA, not be a permanent removal of the feature.
    const withTrend = [{ letter: 'B', name: 'Efficiency', rows: [
      { metric: 'Cash conversion', actual: { value: 40, format: 'days' as const, source: 'r.cc' },
        target: null, prior: null,
        status: 'unscored' as const, trend: 'up' as const, trendSvg: null, bulletSvg: null },
    ] }];
    const { container } = render(<ScorecardTable scale="R" groups={withTrend} />);
    expect(container.querySelector('.pack-scorecard-trend')).not.toBeNull();
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toContain('Trend');
  });
});

describe('NegativeEquityBlock', () => {
  it('states the amount and the consequence, not just the number', () => {
    render(<NegativeEquityBlock equity={-250_000} scale="R" />);
    expect(screen.getByText(/\(250 000\)/)).toBeInTheDocument();
    expect(screen.getByText(/liabilities exceed/i)).toBeInTheDocument();
  });
});

describe('NarrativeColumns', () => {
  it('renders a pending-approval placeholder rather than unapproved text', () => {
    render(<NarrativeColumns narrative={{ status: 'pending', body: null, actions: [] }} />);
    expect(screen.getByText(/commentary pending approval/i)).toBeInTheDocument();
  });

  it('renders the action panel BESIDE a pending placeholder, not instead of it', () => {
    // The `pending` branch returned the placeholder and nothing else, so page
    // 4 printed one italic line at 1.0% fill on a sheet of its own. The
    // panel's items come from the matters, which exist whether or not anyone
    // has approved commentary — that is what keeps the pack twelve pages for
    // every company (R-P57) instead of eleven for some.
    const { container } = render(
      <NarrativeColumns
        narrative={{ status: 'pending', body: null, actions: [] }}
        boardActions={['Credit control: approve a credit hold on Acme Holdings.']}
      />,
    );
    expect(screen.getByText(/commentary pending approval/i)).toBeInTheDocument();
    const panel = container.querySelector('.pack-narrative-actions') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('approve a credit hold on Acme Holdings');
    // Labelled as machine-written: it sits beside signed commentary and a
    // reader must be able to tell which is which (R7).
    expect(panel.textContent).toMatch(/Derived from the figures/);
  });

  /**
   * THE DRAWN LAYOUT IS THE MEASURED ONE.
   *
   * The height model and this component are two readings of one page. A page
   * measured stacked and drawn in two columns is a page over its sheet with
   * nothing on it to say so — and the stacked shape exists precisely because
   * the two-column one would not fit. `PackPageBlock.stackActions` is the
   * composer's single answer; this asserts the class the stylesheet keys off
   * it, in both directions, and that it is READ rather than re-derived.
   */
  it('draws the layout the composer measured, both ways round', () => {
    const narrative = { status: 'approved' as const, body: 'Trading held up.', actions: [] };
    const actions = ['Finance: confirm supporting evidence for the FY2024 filing.'];

    const columns = render(<NarrativeColumns narrative={narrative} boardActions={actions} />);
    expect(columns.container.querySelector('.pack-narrative-columns')!.className)
      .not.toContain('is-stacked');
    columns.unmount();

    const stacked = render(
      <NarrativeColumns narrative={narrative} boardActions={actions} stackActions />,
    );
    const el = stacked.container.querySelector('.pack-narrative-columns')!;
    expect(el.className).toContain('is-stacked');
    // The panel is still THERE and still whole — stacking is a layout, not a
    // budget, and nothing about it may drop an action.
    expect(el.querySelector('.pack-narrative-actions')!.textContent)
      .toContain('confirm supporting evidence');
  });

  it('renders no action panel for a DRAFT narrative', () => {
    // A page carrying only the panel would read as a page whose commentary is
    // fine, rather than one whose commentary is unapproved model output.
    const { container } = render(
      <NarrativeColumns
        narrative={{ status: 'draft', body: 'Unapproved.', actions: [] }}
        boardActions={['Credit control: approve a credit hold.']}
      />,
    );
    expect(container.querySelector('.pack-narrative-actions')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it("keeps the approver's own actions out of the derived panel", () => {
    // Two provenances, two columns. One list holding both would be a panel a
    // reader cannot attribute.
    const { container } = render(
      <NarrativeColumns
        narrative={{ status: 'approved', body: 'Trading held up.', actions: ['Approve the facility renewal'] }}
        boardActions={['Finance: confirm supporting evidence.']}
      />,
    );
    const panel = container.querySelector('.pack-narrative-actions') as HTMLElement;
    const body = container.querySelector('.pack-narrative-body') as HTMLElement;
    expect(body.textContent).toContain('Approve the facility renewal');
    expect(panel.textContent).not.toContain('Approve the facility renewal');
    expect(panel.textContent).toContain('confirm supporting evidence');
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
