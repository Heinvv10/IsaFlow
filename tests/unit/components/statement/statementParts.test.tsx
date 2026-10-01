/**
 * The small statement parts that had no test: the sparkline, the balance
 * banner, and the balance-sheet body that assembles them.
 *
 * They are the pieces most easily broken silently. A sparkline given one NaN
 * renders an empty SVG with no error; a banner that mis-reads the tolerance
 * declares an out-of-balance sheet balanced, which is the one failure a
 * statement must never have.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Sparkline } from '@/components/accounting/statement/Sparkline';
import { BalanceCheckBanner } from '@/components/accounting/statement/BalanceCheckBanner';
import { BalanceSheetBody } from '@/components/accounting/BalanceSheetBody';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';

vi.mock('@/components/accounting/AccountDrillDown', () => ({
  AccountDrillDown: ({ accountCode }: { accountCode: string }) => <div>drill {accountCode}</div>,
}));

afterEach(cleanup);

const points = (el: HTMLElement) => el.querySelector('polyline')?.getAttribute('points') ?? null;

describe('Sparkline', () => {
  it('drops non-finite points rather than losing the whole line', () => {
    // One NaN makes min/max NaN and every coordinate NaN, so the polyline
    // disappears with no error: a missing month silently deletes the line.
    const { container } = render(<Sparkline points={[1, NaN, 3, Infinity, 4]} />);
    const p = points(container)!;
    expect(p).not.toBeNull();
    expect(p).not.toContain('NaN');
    expect(p.split(' ')).toHaveLength(3);
  });

  it('draws nothing for fewer than two usable points', () => {
    const { container } = render(<Sparkline points={[5]} />);
    expect(points(container)).toBeNull();
    const allNaN = render(<Sparkline points={[NaN, NaN]} />);
    expect(points(allNaN.container)).toBeNull();
  });

  it('a flat series still draws, rather than dividing by a zero span', () => {
    const { container } = render(<Sparkline points={[7, 7, 7]} />);
    expect(points(container)).not.toContain('NaN');
  });
});

describe('BalanceCheckBanner', () => {
  it('says balanced when A = L + E within a cent', () => {
    render(<BalanceCheckBanner totalAssets={500000.01} totalLiabilities={200000} totalEquity={300000} />);
    expect(screen.getByText(/balanced/i)).toBeInTheDocument();
  });

  it('names the amount when it does not balance', () => {
    render(<BalanceCheckBanner totalAssets={500000} totalLiabilities={200000} totalEquity={270000} />);
    // The gap, in the statement's own money format — not formatCurrency.
    expect(screen.getByText(/Out of balance by/)).toHaveTextContent('R 30 000.00');
  });

  it('says nothing on an empty sheet: zero assets against zero claims is not a defect', () => {
    const { container } = render(<BalanceCheckBanner totalAssets={0} totalLiabilities={0} totalEquity={5} />);
    expect(container.textContent).toBe('');
  });
});

const REPORT = {
  asAtDate: '2026-08-31',
  assets: [{ accountCode: '1000', accountName: 'Bank', balance: 500000 }],
  liabilities: [{ accountCode: '2000', accountName: 'Creditors', balance: 200000 }],
  equity: [{ accountCode: '3000', accountName: 'Retained income', balance: 300000 }],
  totalAssets: 500000, totalLiabilities: 200000, totalEquity: 300000,
} as unknown as BalanceSheetReport;

describe('BalanceSheetBody', () => {
  const body = () => render(
    <BalanceSheetBody report={REPORT} showComparative={false} expandedAccount={null}
      onToggleAccount={vi.fn()} drillDownStart="2026-03-01" drillDownEnd="2026-08-31" onEvidence={vi.fn()} />,
  );

  it('renders the banner and BOTH grids', () => {
    const { container } = body();
    expect(screen.getByText(/balanced/i)).toBeInTheDocument();
    expect(container.querySelectorAll('table')).toHaveLength(2);
    // "Assets" is both the grid's title and its band header, so count rather
    // than assert uniqueness.
    expect(screen.getAllByText('Assets').length).toBeGreaterThan(0);
    expect(screen.getByText('Equity and Liabilities')).toBeInTheDocument();
    expect(screen.getByText('Total Equity and Liabilities')).toBeInTheDocument();
  });

  it('links every account to account detail, carrying the drill-down window', () => {
    body();
    expect(screen.getByRole('link', { name: 'Bank' })).toHaveAttribute(
      'href', '/accounting/reports/account-detail/1000?from=2026-03-01&to=2026-08-31&source=bs',
    );
    expect(screen.getByRole('link', { name: 'Creditors' })).toBeInTheDocument();
  });
});
