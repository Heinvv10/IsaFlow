// A failed load/action shows the server's message (400) or a plain sentence (empty 500), never a blank table or a raw JSON error.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusG6';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import DebtorsManagerPage from '../../../pages/accounting/debtors-manager/index';
import ConsolidatedTrialBalancePage from '../../../pages/accounting/group/trial-balance';
import LoanPeriodClosePage from '../../../pages/accounting/loans/period-close';
import NetcashSubmissionsPage from '../../../pages/accounting/netcash/index';
import ItemListingReport from '../../../pages/accounting/reports/item-listing';
import SalesByItemReport from '../../../pages/accounting/reports/sales-by-item';

configure({ asyncUtilTimeout: 4000 });
const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
afterEach(() => { cleanup(); });

describe('Debtors manager', () => {
  const SITE = '/api/accounting/debtors-manager';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<DebtorsManagerPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<DebtorsManagerPage />);
    expect(await screen.findByText('Could not load debtors data - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the debtors on success', async () => {
    script([[SITE, () => okRes({ summary: [{ clientId: 'k1', clientName: 'D2 Debtor Ltd', current: 0, days30: 0, days60: 0, days90: 0, days90Plus: 0, totalOutstanding: 10, invoiceCount: 1 }], stats: null, overdueInvoices: [] })]]);
    render(<DebtorsManagerPage />);
    expect(await screen.findByText('D2 Debtor Ltd')).toBeTruthy();
  });
});

describe('Consolidated trial balance entity groups', () => {
  const SITE = '/api/accounting/company-groups';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<ConsolidatedTrialBalancePage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<ConsolidatedTrialBalancePage />);
    expect(await screen.findByText('Could not load entity groups - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the groups on success', async () => {
    const tb = { groupAccounts: [], entityNames: {}, totals: { entities: {}, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 0 },
      accountCount: 0, difference: 0, balanced: true, unmapped: { accountCount: 0, value: 0, byEntity: [] }, coterminous: true };
    script([[SITE, () => okRes({ items: [{ id: 'g1', name: 'D2 Group' }] })], ['consolidated-reports', () => okRes(tb)]]);
    render(<ConsolidatedTrialBalancePage />);
    expect(await screen.findByRole('option', { name: 'D2 Group' })).toBeTruthy();
  });
});

describe('Loan period close', () => {
  const LOAN = { loanId: 'l1', reference: 'D2-LOAN-9', description: null, product: null, principalBalance: 100, rateMode: 'FIXED', margin: 0, fixedRate: 10, nextPaymentDate: null, accruedInterest: 5, periodStatus: 'open' };
  const PERIOD = { yyyymm: '202601', month: 1, year: 2026, locked: false, loans: [LOAN] };
  const run = (post: () => Response | null, get: () => Response = () => okRes(PERIOD)) =>
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) => (init?.method === 'POST' ? post() : null) ?? get());
  it('shows the server message when the period cannot be loaded (400)', async () => {
    run(() => null, bad400); render(<LoanPeriodClosePage />); expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('shows a plain sentence when the period load returns an empty 500', async () => {
    run(() => null, empty500); render(<LoanPeriodClosePage />);
    expect(await screen.findByText('Could not load period data - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the loans on success', async () => { run(() => null); render(<LoanPeriodClosePage />); expect(await screen.findByText('D2-LOAN-9')).toBeTruthy(); });
  it('shows the server message when posting one loan is refused (400)', async () => {
    run(bad400); render(<LoanPeriodClosePage />);
    await screen.findByText('D2-LOAN-9'); // the loan row (data) is on screen before any click
    fireEvent.click(screen.getByRole('button', { name: 'Post' })); expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('shows a plain sentence when posting one loan returns an empty 500', async () => {
    run(empty500); render(<LoanPeriodClosePage />);
    await screen.findByText('D2-LOAN-9'); // the loan row (data) is on screen before any click
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    expect(await screen.findByText('Could not post the journals - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the server message when Post All is refused (400)', async () => {
    run(bad400); render(<LoanPeriodClosePage />);
    await screen.findByText('D2-LOAN-9');
    fireEvent.click(screen.getByRole('button', { name: /Post All Unposted/ })); expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('shows a plain sentence when Post All returns an empty 500', async () => {
    run(empty500); render(<LoanPeriodClosePage />);
    await screen.findByText('D2-LOAN-9');
    fireEvent.click(screen.getByRole('button', { name: /Post All Unposted/ }));
    expect(await screen.findByText('Could not post the journals - try again')).toBeTruthy(); noRawJson();
  });
});

describe('Netcash submissions', () => {
  const SITE = '/api/accounting/netcash/submissions';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<NetcashSubmissionsPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<NetcashSubmissionsPage />);
    expect(await screen.findByText('Could not load submissions - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the submissions on success', async () => {
    script([[SITE, () => okRes({ total: 1, items: [{ id: 's1', submission_type: 'eft_payment', batch_reference: 'D2-BATCH-42', total_amount_cents: 1000, record_count: 2,
      status: 'completed', submitted_at: null, created_at: '2026-01-01T00:00:00Z', created_by: null }] })]]);
    render(<NetcashSubmissionsPage />);
    expect(await screen.findByText('D2-BATCH-42')).toBeTruthy();
  });
});

describe('Item listing report', () => {
  const SITE = '/api/accounting/reports/item-listing';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<ItemListingReport />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<ItemListingReport />);
    expect(await screen.findByText('Could not load the item listing - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the items on success', async () => {
    script([[SITE, () => okRes([{ id: 'i1', itemCode: 'D2-ITEM-5', name: 'D2 Widget', category: 'c', uom: 'ea', sellingPrice: 1, costPrice: 1, qtyOnHand: 1, isActive: true }])]]);
    render(<ItemListingReport />);
    expect(await screen.findByText('D2 Widget')).toBeTruthy();
  });
});

describe('Sales by item report', () => {
  const SITE = '/api/accounting/reports/sales-by-item';
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<SalesByItemReport />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    script([[SITE, empty500]]); render(<SalesByItemReport />);
    expect(await screen.findByText('Could not load sales by item - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the items on success', async () => {
    script([[SITE, () => okRes([{ id: 'i1', itemCode: 'D2-ITEM-6', name: 'D2 Gadget', category: 'c', timesSold: 1, qtySold: 1, totalRevenue: 1, avgPrice: 1 }])]]);
    render(<SalesByItemReport />);
    expect(await screen.findByText('D2 Gadget')).toBeTruthy();
  });
});
