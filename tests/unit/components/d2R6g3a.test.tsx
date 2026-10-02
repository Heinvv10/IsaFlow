// D2 round 6 (g3a): list pages show the server message on a 4xx, a plain sentence on an empty 500, and a
// failed RELOAD clears the previous rows instead of leaving them beside the error.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import ExpensesPage from '../../../pages/accounting/expenses/index';
import DisputesPage from '../../../pages/accounting/disputes/index';
import RecipientsPage from '../../../pages/accounting/practice/report-recipients/index';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Failed to/);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const PAGES: [string, () => JSX.Element, RegExp][] = [
  ['expense claims', () => <ExpensesPage />, /could not load expense claims/i],
  ['disputes', () => <DisputesPage />, /could not load disputes/i],
  ['report recipients', () => <RecipientsPage />, /could not load report recipients/i],
];

describe.each(PAGES)('%s load', (_n, Page, sentence) => {
  it('4xx shows the server message', async () => {
    vi.mocked(apiFetch).mockResolvedValue(bad400());
    render(<Page />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('empty 500 shows a plain sentence, no raw tokens', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => empty500());
    render(<Page />);
    expect(await screen.findByText(sentence)).toBeTruthy();
    noRaw();
  });
});

describe('failed reload clears the previous rows', () => {
  it('expense claims: filter change -> 500 drops the old claim', async () => {
    const claim = { id: 'c1', claimNumber: 'EXP-D2-1', status: 'draft', totalAmount: 10, totalVat: 1, employeeId: 'e1', title: null, claimDate: '2026-01-01' };
    let fail = false;
    vi.mocked(apiFetch).mockImplementation(async () => (fail ? empty500() : ok({ claims: [claim] })));
    const { container } = render(<ExpensesPage />);
    await waitFor(() => expect(document.body.textContent).toContain('EXP-D2-1'));
    fail = true;
    fireEvent.change(container.querySelector('select')!, { target: { value: 'approved' } });
    expect(await screen.findByText(/could not load expense claims/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('EXP-D2-1');
  });
  it('report recipients: delete succeeds, reload fails -> rows cleared, error shown', async () => {
    const r = { id: 'r1', email: 'd2-recipient@example.test', name: null, isActive: true, reportTypes: [] };
    let reloadFails = false;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if ((init?.method ?? 'GET') === 'DELETE') { reloadFails = true; return ok({}); }
      return reloadFails ? empty500() : ok([r]);
    });
    render(<RecipientsPage />);
    await waitFor(() => expect(document.body.textContent).toContain('d2-recipient@example.test'));
    fireEvent.click(document.querySelector('button[title*="elete" i], button[aria-label*="elete" i]') as HTMLElement);
    expect(await screen.findByText(/could not load report recipients/i)).toBeTruthy();
    expect(document.body.textContent).not.toContain('d2-recipient@example.test');
  });
});
