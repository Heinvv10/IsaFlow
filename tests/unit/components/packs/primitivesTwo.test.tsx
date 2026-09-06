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
