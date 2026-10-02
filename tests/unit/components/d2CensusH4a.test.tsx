// D2 census group 4 (a): a failed load/action shows the server's message (400) or a plain sentence (empty 500), never a blank view or raw JSON.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, rawJsonError, router } from '../helpers/d2CensusH4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
const routerState = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: routerState.query, push: routerState.push, replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import DunningPage from '../../../pages/accounting/ar/dunning/index';
import AssetRegisterPage from '../../../pages/accounting/assets/register';
import NewCreditNotePage from '../../../pages/accounting/credit-notes/new';
import SalesOrderPage from '../../../pages/accounting/customer-sales-orders/[id]';
import ExpenseClaimPage from '../../../pages/accounting/expenses/[id]';

const script = (routes: Array<[string, () => Response]>, fallback: unknown = []) => vi.mocked(apiFetch).mockReset().mockImplementation(router(routes, fallback));
const noRawJson = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
beforeEach(() => { routerState.query = {}; routerState.push.mockReset(); });
afterEach(() => { cleanup(); });

describe('Dunning templates load', () => {
  const TPL = { id: 't1', name: 'D2 Polite reminder', tone: 'polite', escalation_order: 1, days_overdue_min: 1, days_overdue_max: 9,
    subject_template: 's', body_template: 'b', send_weekdays_only: true, active: true };
  const SET = { auto_send_enabled: false, min_outstanding_zar: 0 };
  const open = (templates: () => Response, settings: () => Response = () => okRes({ settings: SET })) => {
    script([['dunning/templates', templates], ['dunning/settings', settings]]); render(<DunningPage />);
  };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows the server message when only the settings are refused', async () => { open(() => okRes({ templates: [TPL] }), bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load dunning templates - try again')).toBeTruthy(); noRawJson();
  });
  it('shows a plain sentence on an empty-500 settings load', async () => {
    open(() => okRes({ templates: [TPL] }), empty500); expect(await screen.findByText('Could not load dunning settings - try again')).toBeTruthy(); noRawJson();
  });
  it('lists the templates on success', async () => { open(() => okRes({ templates: [TPL] })); expect(await screen.findByText('D2 Polite reminder')).toBeTruthy(); });
});

describe('Asset register load', () => {
  const SITE = 'assets-register';
  const ASSET = { id: 'a1', asset_number: 'FA-D2-1', name: 'D2 Forklift', category: 'plant', category_name: 'Plant', purchase_date: '2026-01-01',
    purchase_price: 100, total_depreciation: 10, net_book_value: 90, depreciation_method: 'sl', status: 'active', sars_rate: 20 };
  it('shows the server message on a 400', async () => { script([[SITE, bad400]]); render(<AssetRegisterPage />); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500, not an empty register', async () => {
    script([[SITE, empty500]]); render(<AssetRegisterPage />);
    expect(await screen.findByText('Could not load the asset register - try again')).toBeTruthy(); noRawJson();
    expect(screen.queryByText('No assets found for this period')).toBeNull();
  });
  it('lists the assets on success', async () => {
    script([[SITE, () => okRes({ assets: [ASSET], summary: { totalAssets: 1, totalCost: 100, totalAccumulatedDepreciation: 10, totalBookValue: 90, asOfDate: '2026-01-31' } })]]);
    render(<AssetRegisterPage />);
    expect(await screen.findByText('D2 Forklift')).toBeTruthy();
  });
});

describe('New credit note submit', () => {
  const submit = async (res: () => Response) => {
    script([['/accounting/credit-notes', res], ['/accounting/customers', () => okRes([{ id: 'k1', company_name: 'D2 Client Pty' }])]]);
    const { container } = render(<NewCreditNotePage />);
    await screen.findByRole('option', { name: 'D2 Client Pty' });
    fireEvent.submit(container.querySelector('form')!);
  };
  it('shows the server message on a 400', async () => { await submit(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    await submit(empty500); expect(await screen.findByText('Could not create the credit note - try again')).toBeTruthy(); noRawJson();
  });
  it('goes back to the list on success', async () => {
    await submit(() => okRes({ id: 'cn1' })); await waitFor(() => expect(routerState.push).toHaveBeenCalledWith('/accounting/credit-notes'));
  });
});

describe('Sales order detail load', () => {
  const SITE = 'customer-sales-orders?id=';
  const open = (r: () => Response) => { routerState.query = { id: 'o1' }; script([[SITE, r]]); render(<SalesOrderPage />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load the order - try again')).toBeTruthy(); noRawJson();
  });
  it('shows the order on success', async () => {
    open(() => okRes({ id: 'o1', orderNumber: 'D2-SO-9', customerName: 'D2 Customer', orderDate: '2026-01-01', status: 'draft', subtotal: 1, taxAmount: 0, totalAmount: 1 }));
    expect(await screen.findByText('D2-SO-9')).toBeTruthy();
  });
});

describe('Expense claim GL account list', () => {
  const CLAIM = { id: 'c1', claimNumber: 'EXP-D2-1', claimDate: '2026-06-22', employeeId: 'e1', title: 'Stationery', description: null, status: 'approved',
    totalAmount: 115, totalVat: 15, approvedBy: null, approvedAt: null, rejectionReason: null, postedJeId: null, postedAt: null, submittedAt: null, lines: [] };
  const open = (accounts: () => Response) => { routerState.query = { id: 'c1' }; script([['chart-of-accounts', accounts], ['expense-claims/c1', () => okRes({ claim: CLAIM })]]); render(<ExpenseClaimPage />); };
  it('shows the server message on a 400', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => {
    open(empty500); expect(await screen.findByText('Could not load GL accounts - try again')).toBeTruthy(); noRawJson();
  });
  it('offers the accounts when posting on success', async () => {
    open(() => okRes({ accounts: [{ id: 'a1', code: '2300', name: 'D2 Reimbursements' }] }));
    fireEvent.click(await screen.findByText('Post to GL'));
    expect((await screen.findAllByRole('option', { name: '2300 — D2 Reimbursements' })).length).toBeGreaterThan(0);
  });
});
