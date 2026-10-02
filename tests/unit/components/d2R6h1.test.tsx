// D2 round 6 h1: stale rows cleared after a failing reload (audit trail), a failed compliance run reports the server message
// and clears its flag, and a 2xx convert-to-order without an id neither navigates nor claims the conversion failed.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
const push = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push, replace: push, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import AuditTrailPage from '../../../pages/accounting/reports/audit-trail';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import { LoanComplianceTab } from '../../../src/components/loans/LoanComplianceTab';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Assessment failed/);

beforeEach(() => { vi.mocked(apiFetch).mockReset(); push.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('audit trail: a failing reload clears the old rows', () => {
  it('shows the error and no stale entry after the period changes', async () => {
    const row = { entryDate: '2026-01-02', entryNumber: 'JE-D2-STALE', description: 'd', source: 'manual', status: 'posted', totalDebit: 1, totalCredit: 1, createdBy: 'u', createdAt: '2026-01-02', postedAt: null };
    let calls = 0;
    vi.mocked(apiFetch).mockImplementation(async () => (++calls === 1 ? ok([row]) : bad400()));
    const { container } = render(<AuditTrailPage />);
    expect(await screen.findByText('JE-D2-STALE')).toBeTruthy();
    fireEvent.change(container.querySelectorAll('input[type="date"]')[0]!, { target: { value: '2025-12-01' } });
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('JE-D2-STALE')).toBeNull();
  });
});

describe('loan compliance: running an assessment', () => {
  const run = async (fail: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => ((init?.method ?? 'GET') === 'POST' ? fail() : ok([])));
    render(<LoanComplianceTab loanId="l-1" />);
    const btn = await screen.findByRole('button', { name: /run assessment/i });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    return btn as HTMLButtonElement;
  };
  it('400: the server message, and the button is usable again', async () => {
    const btn = await run(bad400);
    expect(await screen.findByText(MSG)).toBeTruthy();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
  it('empty 500: a plain sentence', async () => {
    await run(empty500);
    expect(await screen.findByText('Could not run the compliance assessment - try again')).toBeTruthy();
    noRaw();
  });
});

describe('customer quotes: convert to sales order', () => {
  it('a 2xx without an order id does not navigate and does not say the conversion failed', async () => {
    const quote = { id: 'q-1', quoteNumber: 'Q-D2-1', customerName: 'Acme', quoteDate: '2026-01-01', expiryDate: null, status: 'accepted', total: 100 };
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customer-quotes-action') && init?.method === 'POST') return ok({});
      return String(url).includes('/customer-quotes?') ? ok({ quotes: [quote], total: 1 }) : ok([]);
    });
    const alert = vi.fn();
    vi.stubGlobal('alert', alert);
    vi.stubGlobal('confirm', () => true);
    render(<CustomerQuotesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /to so/i }));
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(String(alert.mock.calls[0]![0])).toMatch(/converted but the order could not be opened/);
    expect(push).not.toHaveBeenCalled();
  });
});
