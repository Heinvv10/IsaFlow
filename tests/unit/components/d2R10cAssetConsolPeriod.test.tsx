// D2 round 10 (c): assets/[assetId] (+ disposal), consolidation (+ add subsidiary), loans/period-close. Real route envelopes:
//   GET assets -> data = snake_case asset rows[]; POST assets/:id/dispose -> data { assetId, journalEntryId, ... };
//   consolidation/companies -> data { items }; consolidation/trial-balance -> data ConsolidatedTrialBalance;
//   loans/period-close GET -> data { yyyymm, month, year, locked, loans }; POST -> data { yyyymm, posted, errors }.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoJargon, ok, on, refuse, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import AssetPage from '../../../pages/accounting/assets/[assetId]';
import ConsolidationPage from '../../../pages/accounting/consolidation/index';
import PeriodClosePage from '../../../pages/accounting/loans/period-close';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockClear(); route.query = {}; });
afterEach(() => { cleanup(); });
const lastBody = (method: string, part: string) => {
  const c = vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === method).pop()!;
  return JSON.parse(String((c[1] as RequestInit).body));
};
const money = (digits: string) => new RegExp(digits.replace(' ', '[\\s\\u00a0\\u202f]'));

describe('assets/[assetId]', () => {
  const asset = { id: 'as1', asset_number: 'FA-D2-1', name: 'D2 Laptop', category: 'Computers', purchase_date: '2025-01-15', purchase_price: 12345,
    current_book_value: 9876, useful_life_years: 5, status: 'active', location: 'D2 Cape Town', serial_number: 'SN-D2-42', supplier_name: 'D2 Supplier',
    sars_category: null, sars_rate: null, tax_life: null, created_at: '2025-01-15', salvage_value: 0, depreciation_method: 'straight_line' };
  beforeEach(() => { route.query = { assetId: 'as1' }; });
  it('load: shows the asset name, number, location, serial, price and book value from the served row', async () => {
    serve(on('GET', '/api/accounting/assets', () => ok([{ ...asset, id: 'other', name: 'D2 Other' }, asset])));
    render(<AssetPage />);
    expect(await screen.findByText('D2 Laptop')).toBeDefined();
    expect(screen.queryByText('D2 Other')).toBeNull();
    for (const t of ['FA-D2-1', 'D2 Cape Town', 'SN-D2-42', 'D2 Supplier']) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getAllByText(money('R 12 345,00')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(money('R 9 876,00')).length).toBeGreaterThan(0);
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no asset', async () => {
    serve(on('GET', '/api/accounting/assets', () => refuse()));
    render(<AssetPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', '/api/accounting/assets', empty500));
    render(<AssetPage />);
    expect(await screen.findByText('Could not load the asset - try again')).toBeDefined();
    expect(screen.queryByText('D2 Laptop')).toBeNull(); expectNoJargon();
  });
  async function dispose(answer: () => Response) {
    serve(on('POST', '/dispose', answer), on('GET', '/api/accounting/assets', () => ok([asset])));
    render(<AssetPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Dispose Asset/ }));
    fireEvent.change(document.querySelector('[name="disposal_amount"]') as HTMLInputElement, { target: { value: '800' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Disposal/ }));
  }
  it('dispose: a 400 refusal shows the server message and stays on the page', async () => {
    await dispose(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
  });
  it('dispose: an empty 500 shows a sentence and stays on the page', async () => {
    await dispose(empty500);
    expect(await screen.findByText('Could not dispose of the asset - try again')).toBeDefined();
    expect(route.push).not.toHaveBeenCalled(); expectNoJargon();
  });
  it('dispose: success posts the typed proceeds to the asset dispose route and returns to the asset list', async () => {
    await dispose(() => ok({ assetId: 'as1', policyGainLoss: -100, journalEntryId: 'je-9' }));
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/assets'));
    expect(String(vi.mocked(apiFetch).mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'POST')![0])).toBe('/api/accounting/assets/as1/dispose');
    expect(lastBody('POST', '/dispose')).toMatchObject({ proceeds: 800, disposalType: 'scrap' });
  });
});

describe('consolidation', () => {
  const company = { id: 'ch-1', name: 'D2 Subsidiary Pty', relationshipType: 'subsidiary', ownershipPercent: 75 };
  const tb = { groupName: 'D2 Group', periodStart: '2026-10-01', periodEnd: '2026-10-31', entities: [{ companyId: 'e1', companyName: 'D2 Parent Co' }],
    accounts: [{ accountCode: 'D2-1100', accountName: 'D2 Cash', accountType: 'asset', byEntity: { e1: { debit: 7777, credit: 0 } }, totalDebit: 7777, totalCredit: 0, isEliminated: false }],
    totalDebits: 7777, totalCredits: 7777 };
  const companies = (answer: () => Response) => on('GET', 'consolidation/companies', answer);
  it('load: lists each group company with its relationship and ownership from data.items', async () => {
    serve(companies(() => ok({ items: [company] })));
    render(<ConsolidationPage />);
    const row = (await screen.findByText('D2 Subsidiary Pty')).closest('tr') as HTMLElement;
    expect(within(row).getByText('75.00%')).toBeDefined();
    expect(within(row).getByText('ch-1')).toBeDefined();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no companies', async () => {
    serve(companies(() => refuse()));
    render(<ConsolidationPage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(companies(empty500));
    render(<ConsolidationPage />);
    expect(await screen.findByText('Could not load group companies - try again')).toBeDefined();
    expect(screen.queryByText('D2 Subsidiary Pty')).toBeNull(); expectNoJargon();
  });
  const run = async (answer: () => Response) => {
    serve(companies(() => ok({ items: [company] })), on('GET', 'consolidation/trial-balance', answer));
    render(<ConsolidationPage />);
    await screen.findByText('D2 Subsidiary Pty');
    fireEvent.click(screen.getByRole('button', { name: /Run/ }));
  };
  it('report: success renders the group, entity, account and totals from the served trial balance', async () => {
    await run(() => ok(tb));
    expect(await screen.findByText(/D2 Group — 2026-10-01 to 2026-10-31/)).toBeDefined();
    expect(screen.getByText('D2 Parent Co')).toBeDefined();
    const row = screen.getByText('D2 Cash').closest('tr') as HTMLElement;
    expect(within(row).getByText('D2-1100')).toBeDefined();
    expect(row.textContent).toMatch(money('7 777,00'));
  });
  it('report: a 400 refusal shows the server message; an empty 500 shows the sentence; no table', async () => {
    await run(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    await run(empty500);
    expect(await screen.findByText('Could not load the report - try again')).toBeDefined();
    expect(screen.queryByText('D2 Cash')).toBeNull(); expectNoJargon();
  });
  async function addSub(answer: () => Response) {
    serve(companies(() => ok({ items: [] })), on('POST', 'consolidation/companies', answer));
    render(<ConsolidationPage />);
    fireEvent.click((await screen.findAllByRole('button', { name: /Add (First )?Subsidiary/ }))[0]!);
    fireEvent.change(screen.getByPlaceholderText('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'), { target: { value: 'ch-1' } });
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
  }
  it('add subsidiary: a 400 refusal shows the server message; an empty 500 shows the sentence; the modal stays open', async () => {
    await addSub(() => refuse());
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    await addSub(empty500);
    expect(await screen.findByText('Could not add the subsidiary - try again')).toBeDefined();
    expect(screen.getByText('Child Company ID (UUID)')).toBeDefined(); expectNoJargon();
  });
  it('add subsidiary: success posts the typed id, closes the modal and lists the returned companies', async () => {
    await addSub(() => ok({ items: [company] }));
    expect(await screen.findByText('D2 Subsidiary Pty')).toBeDefined();
    expect(screen.queryByText('Child Company ID (UUID)')).toBeNull();
    expect(lastBody('POST', 'consolidation/companies')).toMatchObject({ childCompanyId: 'ch-1', ownershipPercent: 100 });
  });
});

describe('loans/period-close', () => {
  const loan = { loanId: 'loan-aaaa-1111', reference: 'D2-LN-7', description: 'D2 bond', product: 'bond', principalBalance: 555000, rateMode: 'FIXED', margin: 0,
    fixedRate: 11.5, nextPaymentDate: '2026-10-28', accruedInterest: 4321, periodStatus: 'open' };
  const period = (loans: unknown[], locked = false) => ({ yyyymm: '202610', month: 10, year: 2026, locked, loans });
  it('load: lists each loan with reference, principal, rate and accrued interest, and the unposted count', async () => {
    serve(on('GET', 'loans/period-close', () => ok(period([loan]))));
    render(<PeriodClosePage />);
    const row = (await screen.findByText('D2-LN-7')).closest('tr') as HTMLElement;
    expect(row.textContent).toMatch(money('555 000,00')); expect(row.textContent).toMatch(money('4 321,00'));
    expect(within(row).getByText('11.5%')).toBeDefined();
    expect(screen.getByText('1 active loans — 1 unposted')).toBeDefined();
  });
  it('load: a 400 refusal shows the server message; an empty 500 shows the sentence; no loans', async () => {
    serve(on('GET', 'loans/period-close', () => refuse()));
    render(<PeriodClosePage />);
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    serve(on('GET', 'loans/period-close', empty500));
    render(<PeriodClosePage />);
    expect(await screen.findByText('Could not load period data - try again')).toBeDefined();
    expect(screen.queryByText('D2-LN-7')).toBeNull(); expectNoJargon();
  });
  const post = (answer: () => Response) => {
    let posted = false;
    serve(on('POST', 'loans/period-close', () => { const r = answer(); if (r.ok) posted = true; return r; }),
      on('GET', 'loans/period-close', () => ok(period([{ ...loan, periodStatus: posted ? 'posted' : 'open' }]))));
  };
  it('post: a 400 refusal shows the server message; an empty 500 shows the sentence; the loan stays open', async () => {
    post(() => refuse());
    render(<PeriodClosePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText(MSG)).toBeDefined();
    cleanup();
    post(empty500);
    render(<PeriodClosePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Could not post the journals - try again')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Post' })).toBeDefined(); expectNoJargon();
  });
  it('post: a per-loan error inside a 200 answer is shown as the loan error', async () => {
    post(() => ok({ yyyymm: '202610', posted: [], errors: [{ loanId: 'loan-aaaa-1111', error: 'D2 loan has no GL account' }] }));
    render(<PeriodClosePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText('D2 loan has no GL account')).toBeDefined();
  });
  it('post: success posts the loan id and period, confirms, and the reload shows it as Done', async () => {
    post(() => ok({ yyyymm: '202610', posted: [{ loanId: 'loan-aaaa-1111', journalEntryId: 'je-1', narrative: 'x' }], errors: [] }));
    render(<PeriodClosePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Journal posted successfully')).toBeDefined();
    expect(await screen.findByText('Done')).toBeDefined();
    expect(lastBody('POST', 'loans/period-close')).toMatchObject({ loanIds: ['loan-aaaa-1111'], month: expect.any(Number), year: expect.any(Number) });
  });
});
