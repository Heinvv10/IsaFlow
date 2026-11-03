/**
 * The deck and the income statement page read one comparator route, so a
 * refusal of it reads alike on both (LB2-3): the limiter's 429 names its wait,
 * the server's 400 gives its reason and no reload advice.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { BudgetInfo } from '@/components/accounting/reportControls/ComparatorNotices';
import { classifyBudgetError } from '@/components/accounting/reportControls/useStatementComparators';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import { ApiRequestError } from '@/lib/apiFetch';

const apiJson = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { pack: 'management', from: '2026-09-01', to: '2026-09-30' }, isReady: true, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiJson: (...a: unknown[]) => apiJson(...a) }));
import PresentPackPage from '@/../pages/accounting/reports/present/[pack]';

afterEach(() => { cleanup(); apiJson.mockReset(); });

const INCOME = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30',
  revenue: [{ accountCode: '4000', accountName: 'Sales', amount: 900 }],
  otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 900, totalOtherIncome: 0, totalCostOfSales: 0, totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 900, operatingProfit: 900, netProfit: 900,
} as IncomeStatementReport;
const INFO: BudgetInfo = {
  budgetAbsentYears: [], budgetOutsideFilterYears: [], unallocatedBudget: null,
  partialBudgetCount: 0, splitsMonth: false, retryAfterSecs: null, rejection: null,
};
const SLIDE: Slide = { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} };
const slide = (state: 'limited' | 'refused', info: Partial<BudgetInfo>) => render(
  <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed={false} budget={[]} budgetedCount={0}
    budgetInfo={{ ...INFO, ...info }} budgetFailed={false} budgetRefusal={state} />,
).container;

describe('PresentSlide refusal notices match the statement page', () => {
  it('limited names the wait and offers no reload advice', () => {
    const t = slide('limited', { retryAfterSecs: 30 }).textContent ?? '';
    expect(t).toContain('Too many report requests');
    expect(t).toContain('try again in 30 seconds');
  });
  it('refused gives the server reason, not "reload"', () => {
    const c = slide('refused', { rejection: 'The window spans more than 24 months.' });
    const alert = within(c).getByRole('alert').textContent ?? '';
    expect(alert).toContain('The window spans more than 24 months');
    expect(alert).not.toMatch(/reload/i);
  });
});

describe('classifyBudgetError', () => {
  it('tells 429, 400 and anything else apart', () => {
    expect(classifyBudgetError(new ApiRequestError('x', 429, 12))).toEqual({ kind: 'limited', retryAfterSecs: 12 });
    expect(classifyBudgetError(new ApiRequestError('Window too big', 400))).toEqual({ kind: 'refused', reason: 'Window too big' });
    expect(classifyBudgetError(new ApiRequestError('boom', 500))).toEqual({ kind: 'failed' });
  });
});

describe('the present page classifies a refused comparator like the statement page', () => {
  const load = async (err: Error) => {
    apiJson.mockImplementation((url: string) => {
      if (url.includes('reports-pack')) return Promise.resolve({ pack: { type: 'management', companyName: 'Co', period: 'Sep', generatedAt: '', sections: [{ type: 'income_statement', title: 'Income Statement', data: {} }] } });
      if (url.includes('reports-budget-comparator')) return Promise.reject(err);
      if (url.includes('reports-income-statement')) return Promise.resolve(INCOME);
      return Promise.reject(new Error('no trends'));
    });
    render(<PresentPackPage />);
    await screen.findByText(/Management Pack/);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await screen.findByText('Statement of Comprehensive Income');
  };
  it('a 429 shows the limiter wait', async () => {
    await load(new ApiRequestError('limited', 429, 45));
    expect(await screen.findByText(/try again in 45 seconds/)).toBeInTheDocument();
  });
  it('a 400 shows the server reason', async () => {
    await load(new ApiRequestError('Window not allowed here', 400));
    expect(await screen.findByText(/Window not allowed here/)).toBeInTheDocument();
  });
  it('a 500 stays the plain failure notice', async () => {
    await load(new ApiRequestError('boom', 500));
    expect(await screen.findByText(/The budget could not be loaded/)).toBeInTheDocument();
  });
});
