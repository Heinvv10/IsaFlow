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
    const trendCell = container.querySelector('.pack-scorecard-trend');
    expect(trendCell).not.toBeNull();
    expect(trendCell!.textContent).toBe('');
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
