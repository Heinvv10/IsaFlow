/**
 * #1670 breaker L3, the page's half: a manager without the module's Approve may pause an auto-posting recurring template, which
 * the route allows only for a PUT whose one change is isActive: false. The page's Pause button sends exactly { id, isActive: false }
 * (the edit modal sends the whole template, which the route judges as an edit), and Resume sends { id, isActive: true }. A refusal
 * the route sends is shown. Rendered and clicked.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, pathname: '/accounting/recurring-transactions', query: {}, push: vi.fn(), events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
const company = vi.hoisted(() => ({ companyRole: 'manager', activeCompany: { id: 'co-1', name: 'Co' } })); // one object: a new one each render refetches
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import RecurringTransactionsPage from '../../../pages/accounting/recurring-transactions';

const T = '11111111-1111-4111-8111-111111111111';
const template = (isActive: boolean) => ({
  id: T, name: 'Rent', entityType: 'supplier_invoice', frequency: 'monthly', nextRunDate: '2026-12-01', lastRunDate: null,
  isActive, autoPost: true, templateData: { supplierId: 'x', lines: [{ amount: 100 }] },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let putAnswer: Response;
let listed = template(true);

beforeEach(() => {
  listed = template(true);
  putAnswer = json(200, { success: true, data: { id: T } });
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => (init?.method === 'PUT' ? putAnswer.clone() : json(200, { success: true, data: [listed] })));
});
afterEach(() => { cleanup(); });

const puts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PUT');

describe('recurring transactions page: pause and resume', () => {
  it('Pause sends only { id, isActive: false } (no figures), then reloads', async () => {
    render(<RecurringTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Pause Rent' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [url, init] = puts()[0]!;
    expect(url).toBe('/api/accounting/recurring-transactions');
    expect(JSON.parse(String(init!.body))).toEqual({ id: T, isActive: false });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThanOrEqual(3)); // list, PUT, list again
  });

  it('a paused template offers Resume, which sends only { id, isActive: true }', async () => {
    listed = template(false);
    render(<RecurringTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Rent' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(String(puts()[0]![1]!.body))).toEqual({ id: T, isActive: true });
  });

  it('the route\'s refusal is shown, not swallowed', async () => {
    listed = template(false);
    putAnswer = json(403, { success: false, message: 'You do not have permission to approve supplier invoices.' });
    render(<RecurringTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume Rent' }));
    expect(await screen.findByText(/You do not have permission to approve supplier invoices/)).toBeTruthy();
  });
});
