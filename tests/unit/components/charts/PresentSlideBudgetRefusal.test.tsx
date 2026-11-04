/**
 * The deck and the income statement page read one comparator route, so a
 * refusal of it reads alike on both (LB2-3): the limiter's 429 names its wait,
 * the server's 400 gives its reason and no reload advice.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import { TREND_FAILED, type BudgetInfo } from '@/components/accounting/reportControls/ComparatorNotices';
import { classifyBudgetError } from '@/components/accounting/reportControls/useStatementComparators';
import { budgetStateOf } from '@/components/accounting/reportControls/budgetStateOf';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import { ApiRequestError } from '@/lib/apiFetch';

const apiJson = vi.fn();
const logError = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
let query: Record<string, string> = { pack: 'management', from: '2026-09-01', to: '2026-09-30' };
vi.mock('next/router', () => ({ useRouter: () => ({ query, isReady: true, push: vi.fn() }) }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiJson: (...a: unknown[]) => apiJson(...a) }));
import PresentPackPage from '@/../pages/accounting/reports/present/[pack]';

afterEach(() => { cleanup(); apiJson.mockReset(); query = { pack: 'management', from: '2026-09-01', to: '2026-09-30' }; });

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

const RATIOS: Slide = { id: 'ratios:0', kind: 'ratios', title: 'Ratios', data: {} };
const ratios = (state: 'limited' | 'refused', info: Partial<BudgetInfo>) => render(
  <PresentSlide slide={RATIOS} income={null} trends={null} trendsFailed={false} budget={[]} budgetedCount={0}
    budgetInfo={{ ...INFO, ...info }} budgetFailed={false} budgetRefusal={state} />,
).container.textContent ?? '';

describe('PresentSlide budget (ratios) slide under a refusal', () => {
  it('limited names the wait, not "No budget was captured"', () => {
    const t = ratios('limited', { retryAfterSecs: 30 });
    expect(t).toContain('try again in 30 seconds');
    expect(t).not.toContain('No budget was captured');
  });
  it('refused gives the server reason, not "No budget was captured"', () => {
    const t = ratios('refused', { rejection: 'The window spans more than 24 months.' });
    expect(t).toContain('The window spans more than 24 months');
    expect(t).not.toContain('No budget was captured');
  });
});

describe('PresentSlide income slide notices beyond the budget', () => {
  it('shows the trend-failed notice as the page does', () => {
    const t = render(
      <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed budget={[]} budgetedCount={0}
        budgetInfo={INFO} budgetFailed={false} />,
    ).container.textContent ?? '';
    expect(t).toContain(TREND_FAILED);
  });
  it('the 429 notice carries a Retry button that calls onRetryBudget', () => {
    const retry = vi.fn();
    const c = render(
      <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed={false} budget={[]} budgetedCount={0}
        budgetInfo={{ ...INFO, retryAfterSecs: 5 }} budgetFailed={false} budgetRefusal="limited" onRetryBudget={retry} />,
    ).container;
    fireEvent.click(within(c).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('budgetStateOf precedence (shared by the statement hook and the deck)', () => {
  const base = { requested: true, failed: false, limited: false, refused: false, budgetedCount: 1 as number | null };
  it.each([
    [{ requested: false, failed: true }, 'unknown'],
    [{ failed: true, limited: true, refused: true }, 'failed'],
    [{ limited: true, refused: true }, 'limited'],
    [{ refused: true }, 'refused'],
    [{ budgetedCount: null }, 'unknown'],
    [{ budgetedCount: 0 }, 'none'],
    [{ budgetedCount: 3 }, 'available'],
  ])('%j -> %s', (over, want) => {
    expect(budgetStateOf({ ...base, ...over })).toBe(want);
  });
});

describe('classifyBudgetError', () => {
  it('tells 429, 400 and anything else apart', () => {
    expect(classifyBudgetError(new ApiRequestError('x', 429, 12))).toEqual({ kind: 'limited', retryAfterSecs: 12 });
    expect(classifyBudgetError(new ApiRequestError('Window too big', 400))).toEqual({ kind: 'refused', reason: 'Window too big' });
    expect(classifyBudgetError(new ApiRequestError('boom', 500))).toEqual({ kind: 'failed' });
  });
  it('a 429 without a Retry-After carries a null wait', () => {
    expect(classifyBudgetError(new ApiRequestError('x', 429))).toEqual({ kind: 'limited', retryAfterSecs: null });
    expect(classifyBudgetError({ status: 429 })).toEqual({ kind: 'limited', retryAfterSecs: null });
  });
  it('a 400 with no message is a plain failure, not a blank refusal', () => {
    expect(classifyBudgetError(new ApiRequestError('', 400))).toEqual({ kind: 'failed' });
  });
  it('a plain Error, null and undefined are failures', () => {
    expect(classifyBudgetError(new Error('network'))).toEqual({ kind: 'failed' });
    expect(classifyBudgetError(null)).toEqual({ kind: 'failed' });
    expect(classifyBudgetError(undefined)).toEqual({ kind: 'failed' });
  });
});

let view: ReturnType<typeof render>;

describe('the present page classifies a refused comparator like the statement page', () => {
  const load = async (err: Error) => {
    apiJson.mockImplementation((url: string) => {
      if (url.includes('reports-pack')) return Promise.resolve({ pack: { type: 'management', companyName: 'Co', period: 'Sep', generatedAt: '', sections: [{ type: 'income_statement', title: 'Income Statement', data: {} }] } });
      if (url.includes('reports-budget-comparator')) return Promise.reject(err);
      if (url.includes('reports-income-statement')) return Promise.resolve(INCOME);
      return Promise.reject(new Error('no trends'));
    });
    view = render(<PresentPackPage />);
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
  it('Retry after a 429 re-asks only the comparator and clears the notice', async () => {
    await load(new ApiRequestError('limited', 429, 45));
    const calls = () => apiJson.mock.calls.filter((c) => String(c[0]).includes('reports-budget-comparator')).length;
    expect(calls()).toBe(1);
    apiJson.mockImplementation((url: string) => String(url).includes('reports-budget-comparator')
      ? Promise.resolve({ lines: [], bands: [], budgetedCount: 0, budgetAbsentYears: [], budgetOutsideFilterYears: [],
        unallocatedBudget: null, partialBudgetCount: 0, splitsMonth: false })
      : Promise.reject(new Error('only the comparator is re-asked')));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/try again in 45 seconds/)).toBeNull());
    expect(calls()).toBe(2);
  });
  it('a Retry still in flight when the window changes cannot overwrite the new window', async () => {
    const comparator = (turnover: number) => ({
      lines: [], bands: [{ key: 'turnover', budget: turnover }], budgetedCount: 1, budgetAbsentYears: [],
      budgetOutsideFilterYears: [], unallocatedBudget: null, partialBudgetCount: 0, splitsMonth: false,
    });
    await load(new ApiRequestError('limited', 429, 45));
    let resolveOld: (v: unknown) => void = () => undefined;
    const old = new Promise((r) => { resolveOld = r; });
    apiJson.mockImplementation((url: string) => {
      if (url.includes('reports-pack')) return Promise.resolve({ pack: { type: 'management', companyName: 'Co', period: 'Oct', generatedAt: '', sections: [{ type: 'income_statement', title: 'Income Statement', data: {} }] } });
      if (url.includes('reports-budget-comparator')) return url.includes('2026-10-01') ? Promise.resolve(comparator(777)) : old;
      if (url.includes('reports-income-statement')) return Promise.resolve(INCOME);
      return Promise.reject(new Error('no trends'));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' })); // old window's Retry, never answered yet
    query = { pack: 'management', from: '2026-10-01', to: '2026-10-31' };
    view.rerender(<PresentPackPage />);
    await screen.findByText(/Management Pack/);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await screen.findByText('Statement of Comprehensive Income');
    await waitFor(() => expect(document.body.textContent).toContain('777'));
    resolveOld(comparator(111));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.textContent).toContain('777');
    expect(document.body.textContent).not.toContain('111');
  });
  it('a Retry in flight when the params become invalid cannot apply under the Unknown pack banner', async () => {
    await load(new ApiRequestError('limited', 429, 45));
    let rejectOld: (e: unknown) => void = () => undefined;
    apiJson.mockImplementation(() => new Promise((_, rej) => { rejectOld = rej; }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    query = { pack: 'nonsense', from: '2026-09-01', to: '2026-09-30' };
    view.rerender(<PresentPackPage />);
    await screen.findByText(/Unknown pack/);
    logError.mockClear();
    rejectOld(new Error('late'));
    await new Promise((r) => setTimeout(r, 20));
    // a superseded answer is dropped before it is read, so it logs nothing and writes nothing
    expect(logError).not.toHaveBeenCalled();
    expect(screen.getByText(/Unknown pack/)).toBeInTheDocument();
  });
  it('a 500 stays the plain failure notice', async () => {
    await load(new ApiRequestError('boom', 500));
    expect(await screen.findByText(/The budget could not be loaded/)).toBeInTheDocument();
  });
});
