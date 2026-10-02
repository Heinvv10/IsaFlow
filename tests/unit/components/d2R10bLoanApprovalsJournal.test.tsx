// D2 round 10 (b): loans/new, practice/approvals, journal-entries/new. Real route envelopes:
//   loan-rate-curves -> data RateCurve[]; POST loans -> 201 data { id }; practice/time-entries -> data { entries, total };
//   practice/users -> data CompanyUserSummary[]; time-entries/approve and /write-off -> data { count };
//   chart-of-accounts -> data GLAccount[] (camelCase); POST journal-entries -> data entry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve, writeCalls } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/practice/PeriodPicker', () => ({ PeriodPicker: () => null }));
vi.mock('@/components/accounting/DescriptionAutocomplete', () => ({
  DescriptionAutocomplete: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) =>
    <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />,
}));

import { apiFetch } from '@/lib/apiFetch';
import NewLoanPage from '../../../pages/accounting/loans/new';
import ApprovalsPage from '../../../pages/accounting/practice/approvals/index';
import NewJournalPage from '../../../pages/accounting/journal-entries/new';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockClear(); route.query = {}; });
afterEach(() => { cleanup(); });
const submit = () => fireEvent.submit(document.querySelector('form') as HTMLFormElement);
const created = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 201 });
const lastBody = (method: string, part: string) => {
  const c = vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === method).pop()!;
  return JSON.parse(String((c[1] as RequestInit).body));
};

describe('loans/new', () => {
  const curve = { id: 'cv1', name: 'D2 Prime Curve' };
  const showCurves = () => fireEvent.change(screen.getByDisplayValue('Fixed'), { target: { value: 'PRIME_PLUS' } });
  it('load: the served curves are offered once the rate mode is Prime', async () => {
    serve(on('GET', 'loan-rate-curves', () => ok([curve])));
    render(<NewLoanPage />);
    await waitFor(() => expect(vi.mocked(apiFetch)).toHaveBeenCalled());
    showCurves();
    expect(await screen.findByText('D2 Prime Curve')).toBeDefined();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence', async () => {
    serve(on('GET', 'loan-rate-curves', () => refuse()));
    render(<NewLoanPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'loan-rate-curves', empty500));
    render(<NewLoanPage />);
    expect(await screen.findByText('Could not load the rate curves - try again')).toBeDefined();
    showCurves(); expect(screen.queryByText('D2 Prime Curve')).toBeNull(); expectNoJargon();
  });
  function fillAndCreate() {
    render(<NewLoanPage />);
    fireEvent.change(screen.getByPlaceholderText('1000000.00'), { target: { value: '250000' } });
    fireEvent.change(screen.getByPlaceholderText('60'), { target: { value: '48' } });
    fireEvent.change(screen.getByPlaceholderText('10.5'), { target: { value: '11.25' } });
    submit();
  }
  it('write: a 400 refusal shows the server message and does not navigate', async () => {
    serve(on('POST', '/api/accounting/loans', () => refuse()));
    fillAndCreate();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('write: an empty 500 shows a sentence and does not navigate', async () => {
    serve(on('POST', '/api/accounting/loans', empty500));
    fillAndCreate();
    expect(await screen.findByText(/^Could not create (the )?loan - try again$/)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled(); expectNoJargon();
  });
  it('write: success posts the typed terms and opens the loan whose id the route returned', async () => {
    serve(on('POST', '/api/accounting/loans', () => created({ id: 'loan-d2-5' })));
    fillAndCreate();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/loans/loan-d2-5'));
    expect(lastBody('POST', '/api/accounting/loans')).toMatchObject({ principal: 250000, termMonths: 48, fixedRate: 11.25, rateMode: 'FIXED' });
  });
});

describe('practice/approvals', () => {
  const entry = { id: 'e1', companyId: 'c1', userId: 'u1', entryDate: '2026-09-15', hours: 3.5, practiceClientId: 'pc1', jobCategoryId: 'j1', workItemId: 'w1',
    taskDescription: 'D2 reconcile the ledger', notes: null, billable: true, appliedRate: 400, lineTotal: 1400, origin: 'manual', status: 'submitted',
    practiceClientName: 'D2 Client Pty', jobCategoryName: 'D2 Bookkeeping', workItemName: 'D2 Monthly' };
  const user = { id: 'u1', email: 'd2@x.test', firstName: 'D2', lastName: 'Clerk', displayName: 'D2 Clerk', companyRole: 'accountant' };
  const base = (list: () => Response) => [on('GET', 'practice/users', () => ok([user])), on('GET', 'practice/clients', () => ok([])), on('GET', 'practice/time-entries', list)];
  it('load: shows each entry (submitter name resolved from users, client, category, description, hours, rate, total) and the count', async () => {
    serve(...base(() => ok({ entries: [entry], total: 1 })));
    render(<ApprovalsPage />);
    const row = (await screen.findByText('D2 reconcile the ledger')).closest('tr') as HTMLElement;
    expect(within(row).getByText('D2 Clerk')).toBeDefined();
    expect(within(row).getByText('D2 Client Pty')).toBeDefined();
    expect(within(row).getByText(/D2 Bookkeeping/)).toBeDefined();
    expect(within(row).getByText('3.50h')).toBeDefined();
    expect(row.textContent).toMatch(/1[\s  ]400,00/);
    expect(screen.getByText('1 entry found')).toBeDefined();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no rows', async () => {
    serve(...base(() => refuse()));
    render(<ApprovalsPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(...base(empty500));
    render(<ApprovalsPage />);
    expect(await screen.findByText('Could not load time entries - try again')).toBeDefined();
    expect(screen.queryByText('D2 reconcile the ledger')).toBeNull(); expectNoJargon();
  });
  const withAction = (part: string, answer: () => Response) => {
    let done = false;
    serve(on('POST', part, () => { const r = answer(); if (r.ok) done = true; return r; }),
      on('GET', 'practice/users', () => ok([user])), on('GET', 'practice/clients', () => ok([])),
      on('GET', 'practice/time-entries', () => ok(done ? { entries: [], total: 0 } : { entries: [entry], total: 1 })));
  };
  const selectRow = async () => { fireEvent.click(await screen.findByText('D2 reconcile the ledger')); };
  it('approve: a 400 refusal shows the server message, an empty 500 a sentence; the row stays', async () => {
    withAction('time-entries/approve', () => refuse());
    render(<ApprovalsPage />);
    await selectRow(); fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByText('D2 reconcile the ledger')).toBeDefined();
    cleanup();
    withAction('time-entries/approve', empty500);
    render(<ApprovalsPage />);
    await selectRow(); fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    expect(await screen.findByText('Could not approve the time entries - try again')).toBeDefined(); expectNoJargon();
  });
  it('approve: success posts the selected ids, confirms, and reloads without the entry', async () => {
    withAction('time-entries/approve', () => ok({ count: 1 }));
    render(<ApprovalsPage />);
    await selectRow(); fireEvent.click(screen.getByRole('button', { name: /Approve selected/ }));
    expect(await screen.findByText('Approved 1 entry')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('D2 reconcile the ledger')).toBeNull());
    expect(lastBody('POST', 'time-entries/approve')).toEqual({ ids: ['e1'] });
  });
  async function writeOff() {
    render(<ApprovalsPage />);
    await selectRow(); fireEvent.click(screen.getByRole('button', { name: /Write off selected/ }));
    fireEvent.change(screen.getByPlaceholderText(/Duplicate work/), { target: { value: 'D2 duplicate' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm write-off' })); });
  }
  it('write-off: a 400 refusal shows the server message, an empty 500 a sentence, and the dialog stays open', async () => {
    withAction('time-entries/write-off', () => refuse());
    await writeOff();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Confirm write-off' })).toBeDefined();
    cleanup();
    withAction('time-entries/write-off', empty500);
    await writeOff();
    expect(await screen.findByText('Could not write off the time entries - try again')).toBeDefined(); expectNoJargon();
  });
  it('write-off: success posts ids and reason, confirms, closes the dialog and reloads', async () => {
    withAction('time-entries/write-off', () => ok({ count: 1 }));
    await writeOff();
    expect(await screen.findByText('Wrote off 1 entry')).toBeDefined();
    await waitFor(() => expect(screen.queryByText('D2 reconcile the ledger')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Confirm write-off' })).toBeNull();
    expect(lastBody('POST', 'time-entries/write-off')).toEqual({ ids: ['e1'], reason: 'D2 duplicate' });
  });
});

describe('journal-entries/new', () => {
  const accounts = [{ id: 'a1', accountCode: '1100', accountName: 'D2 Bank', isActive: true }, { id: 'a2', accountCode: '4100', accountName: 'D2 Sales', isActive: true },
    { id: 'a3', accountCode: '9999', accountName: 'D2 Dormant', isActive: false }];
  it('load: lists the active accounts as "code - name" and hides inactive ones', async () => {
    serve(on('GET', 'chart-of-accounts', () => ok(accounts)));
    render(<NewJournalPage />);
    expect((await screen.findAllByText('1100 - D2 Bank')).length).toBe(2);
    expect(screen.getAllByText('4100 - D2 Sales').length).toBe(2);
    expect(screen.queryByText('9999 - D2 Dormant')).toBeNull();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no accounts', async () => {
    serve(on('GET', 'chart-of-accounts', () => refuse()));
    render(<NewJournalPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'chart-of-accounts', empty500));
    render(<NewJournalPage />);
    expect(await screen.findByText('Could not load accounts - try again')).toBeDefined();
    expect(screen.queryByText('1100 - D2 Bank')).toBeNull(); expectNoJargon();
  });
  async function fillAndPost() {
    render(<NewJournalPage />);
    await screen.findAllByText('1100 - D2 Bank');
    const sel = Array.from(document.querySelectorAll('select[name="accountId"]')) as HTMLSelectElement[];
    fireEvent.change(sel[0]!, { target: { value: 'a1' } }); fireEvent.change(sel[1]!, { target: { value: 'a2' } });
    const amt = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(amt[0]!, { target: { value: '100' } }); fireEvent.change(amt[3]!, { target: { value: '100' } });
    submit();
  }
  const routes = (post: () => Response) => serve(on('GET', 'chart-of-accounts', () => ok(accounts)), on('POST', 'journal-entries', post));
  it('write: a 400 refusal shows the server message and does not navigate', async () => {
    routes(() => refuse());
    await fillAndPost();
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('write: an empty 500 shows a sentence and does not navigate', async () => {
    routes(empty500);
    await fillAndPost();
    expect(await screen.findByText(/^Could not create (the )?journal entry - try again$/)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled(); expectNoJargon();
  });
  it('write: success posts the balanced lines, confirms, then opens the entry id the route returned', async () => {
    routes(() => ok({ id: 'je-d2-3' }));
    await fillAndPost();
    expect(await screen.findByText(/Journal entry created/)).toBeDefined();
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/journal-entries/je-d2-3'), { timeout: 3000 });
    const body = lastBody('POST', 'journal-entries');
    expect(body.lines).toEqual([expect.objectContaining({ glAccountId: 'a1', debit: 100, credit: 0 }), expect.objectContaining({ glAccountId: 'a2', debit: 0, credit: 100 })]);
    expect(writeCalls('POST', 'journal-entries')).toBe(1);
  });
});
