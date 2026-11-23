// Loan Rate Curve and Compliance tabs: header actions are 44px and wrap, and the assessment history becomes labelled cards below lg.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hist = (id: string, stage: number, flagged: boolean) => ({ id, loanId: 'l1', assessmentDate: '2026-0' + id + '-01', stage, daysPastDue: 12, eclAmount: 50, eclMethod: 'simple', outstanding: 900, ncaFlagged: flagged, ncaPeriod: null });
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: [hist('2', 2, false), hist('1', 1, true)] }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import { LoanComplianceTab } from '../../../src/components/loans/LoanComplianceTab';
import { LoanRateCurveTab } from '../../../src/components/loans/LoanRateCurveTab';

afterEach(cleanup);
const cls = (el: Element) => el.className.split(' ');

describe('Loan Compliance tab on touch', () => {
  it('makes Run Assessment 44px and lets the header wrap', async () => {
    render(<LoanComplianceTab loanId="l1" />);
    const btn = await screen.findByRole('button', { name: /Run Assessment/ });
    expect(cls(btn)).toContain('max-lg:min-h-11');
    expect(cls(btn.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(btn.parentElement!)).toContain('max-lg:gap-3');
  });

  it('turns the history table into labelled cards matching its headers', async () => {
    const { container } = render(<LoanComplianceTab loanId="l1" />);
    await screen.findByText('History');
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    const labels = Array.from(table.querySelector('tbody tr')!.querySelectorAll('td')).map((td) => td.getAttribute('data-label'));
    expect(labels).toEqual(['Date', 'Stage', 'DPD', 'ECL', 'Outstanding', 'NCA']);
    expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual(labels);
  });
});

describe('Loan Rate Curve tab on touch', () => {
  it('makes Manage Curves 44px and lets the header wrap', () => {
    render(<LoanRateCurveTab curve={{ id: 'c1', name: 'Prime' } as never} points={[{ effectiveDate: '2026-01-01', rate: 11.5 } as never]} loading={false} />);
    const link = screen.getByRole('link', { name: /Manage Curves/ });
    expect(cls(link)).toContain('max-lg:min-h-11');
    expect(cls(link.parentElement!)).toContain('max-lg:flex-wrap');
    expect(cls(link.parentElement!)).toContain('max-lg:gap-3');
  });
});
