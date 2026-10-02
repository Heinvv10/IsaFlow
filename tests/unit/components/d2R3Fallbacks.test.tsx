// D2 round 3 (browser findings): trial balance main load, write-off save, DRC VAT apply, cashbook, customer report and bank
// transactions report show the server's message on a 4xx and a plain sentence (never a bare "Failed") on an empty-body 500.
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { MSG, bad400, empty500, okRes, router, rawJsonError } from '../helpers/d2CensusH4';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ isReady: true, query: {}, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true, known: true }) }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '', headerClass: '' }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '../../../pages/accounting/trial-balance/index';
import WriteOffsPage from '../../../pages/accounting/write-offs/index';
import DrcVatPage from '../../../pages/accounting/drc-vat/index';
import CashbookPage from '../../../pages/accounting/cashbook';
import CustomerReportsPage from '../../../pages/accounting/reports/customer-reports';
import BankTransactionsReportPage from '../../../pages/accounting/reports/bank-transactions';

const script = (routes: Array<[string, (init?: RequestInit) => Response]>, fallback: unknown = []) =>
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    const hit = routes.find(([part]) => u.includes(part));
    return hit ? hit[1](init) : okRes(fallback);
  });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(rawJsonError);
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('trial balance main load', () => {
  const PERIOD = { id: 'p1', periodName: 'D2 January 2026', startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' };
  const open = (r: () => Response) => {
    script([['reports-trial-balance', r], ['fiscal-periods?', () => okRes({ endDate: '2026-01-31' })], ['fiscal-periods', () => okRes([PERIOD])]], { items: [] });
    render(<TrialBalancePage />);
  };
  it('400: the server message (not a fixed "Failed to load")', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => {
    open(empty500); expect(await screen.findByText('Could not load the trial balance - try again')).toBeTruthy(); noRaw();
  });
  it('200: the rows render', async () => {
    open(() => okRes({ rows: [{ accountCode: '9D2X', accountName: 'D2 Suspense', accountType: 'asset', amount: 5, balance: 5,
      debitBalance: 5, creditBalance: 0 }], totalDebit: 5, totalCredit: 5, difference: 0, balanced: true, accountCount: 1 }));
    expect((await screen.findAllByText(/D2 Suspense/)).length).toBeGreaterThan(0);
  });
});

describe('write-off save', () => {
  const submit = async (r: () => Response) => {
    script([['/write-offs', (init) => (init?.method === 'POST' ? r() : okRes({ items: [] }))]], {});
    const { container } = render(<WriteOffsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /New Write-Off/ }));
    fireEvent.submit(container.querySelector('form')!);
  };
  it('400: the server message', async () => { await submit(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence, not "Failed"', async () => {
    await submit(empty500);
    expect(await screen.findByText('Could not save the write-off - try again')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull(); noRaw();
  });
});

describe('DRC VAT apply', () => {
  const apply = async (r: () => Response) => {
    script([['/drc-vat', (init) => (init?.method === 'POST' ? r() : okRes({ items: [{ id: 'i1', invoiceNumber: 'INV-D2-1', supplierName: 'S', totalAmount: 100, vatAmount: 0, invoiceDate: '2026-01-01' }] }))]], {});
    render(<DrcVatPage />);
    fireEvent.click(await screen.findByRole('button', { name: /apply drc/i }));
  };
  it('400: the server message', async () => { await apply(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence', async () => {
    await apply(empty500); expect(await screen.findByText('Could not apply DRC VAT - try again')).toBeTruthy();
    expect(screen.queryByText('Failed')).toBeNull(); noRaw();
  });
});

describe.each([
  ['cashbook', () => <CashbookPage />, 'bank-transactions?', 'Could not load the cashbook - try again'],
  ['customer report', () => <CustomerReportsPage />, 'reports-customer', 'Could not load the customer report - try again'],
  ['bank transactions report', () => <BankTransactionsReportPage />, 'reports-bank-transactions', 'Could not load the bank transactions report - try again'],
])('%s load', (_name, page, part, sentence) => {
  const open = (r: () => Response) => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('/bank-accounts')) return okRes([{ id: 'b1', accountCode: '1100', accountName: 'Main Bank' }]);
      if (u.includes('chart-of-accounts')) return okRes([{ id: 'a1', accountCode: '1100', accountName: 'Cheque', parentAccountId: null }]);
      return u.includes(part) ? r() : okRes([]);
    });
    render(page());
  };
  it('400: the server message', async () => { open(bad400); expect(await screen.findByText(MSG)).toBeTruthy(); });
  it('empty 500: a plain sentence, not "Failed"', async () => {
    open(empty500); expect(await screen.findByText(sentence)).toBeTruthy(); expect(screen.queryByText('Failed')).toBeNull(); noRaw();
  });
});
