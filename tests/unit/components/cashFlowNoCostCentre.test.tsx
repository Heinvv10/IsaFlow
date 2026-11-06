/**
 * The Cash Flow screen offered a Cost Centre filter and sent `cost_centre`, which the route never read: choosing a centre
 * showed the whole company's statement under a filter that claimed otherwise. A cost-centre cash flow is not meaningful:
 * cash is held in bank accounts, which no cost centre owns (no cash journal line carries a cost centre), so filtering the
 * lines would leave a statement whose opening and closing cash do not follow from its movements. The screen has no such
 * filter, says why, and sends none; the routes refuse the parameter rather than silently ignore it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', replace: vi.fn(), push: vi.fn(async () => true) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CashFlowPage from '../../../pages/accounting/reports/cash-flow';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; });
afterEach(cleanup);

const REPORT = { period_start: '2026-10-01', period_end: '2026-11-05', opening_cash: 100, sections: [], net_change: 0, closing_cash: 100 };
const urls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));

describe('cash flow screen: no cost-centre filter', () => {
  it('offers no cost-centre control, never loads the centres, and sends no cost_centre', async () => {
    serve(on('GET', 'reports-cash-flow', () => ok({ report: REPORT })), on('GET', 'cost-centres', () => ok({ items: [{ id: 'cc1', code: 'CC9', name: 'D2 Centre' }] })));
    render(<CashFlowPage />);
    await screen.findByText('Opening Cash Balance');
    expect(screen.queryByText('Cost Centre')).toBeNull();
    expect(screen.queryByText(/CC9/)).toBeNull();
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(urls().some((u) => u.includes('cost-centres'))).toBe(false);
    expect(urls().filter((u) => u.includes('reports-cash-flow')).every((u) => !u.includes('cost_centre'))).toBe(true);
  });

  it('says why: cash is held in bank accounts, not by cost centre', async () => {
    serve(on('GET', 'reports-cash-flow', () => ok({ report: REPORT })));
    render(<CashFlowPage />);
    await screen.findByText('Opening Cash Balance');
    expect(screen.getByText(/whole company/i).textContent).toMatch(/bank accounts, not cost centres/i);
  });
});
