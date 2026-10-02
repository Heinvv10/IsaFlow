/**
 * D2: the report pages read `json.message` (always undefined for the real envelope
 * `{ success:false, error:{ code, message } }`), so users saw a generic fallback. Each page now goes
 * through the real assertOk; this proves the server's own message is what the user sees.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'co-1', vatPeriod: 'bi-monthly', vatSystemType: 'standard' }, loading: false }),
}));
vi.mock('next/router', () => ({
  useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(), pathname: '/' }),
}));

import { apiFetch } from '@/lib/apiFetch';

useApiJsonOverMock();
afterEach(cleanup);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok = (data: unknown) => json({ success: true, data });
const refuse = (msg: string, status: number) => json({ success: false, error: { code: 'REFUSED', message: msg } }, status);

/** Answers `failUrl` with the real error envelope; everything else with a valid empty success envelope. */
function script(failUrl: string, msg: string, status: number, extra?: (u: string) => Response | null) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes(failUrl)) return refuse(msg, status);
    return extra?.(u) ?? ok([]);
  });
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });

const loadOnMount: Array<[string, () => Promise<{ default: () => React.ReactElement }>, string, number]> = [
  ['ap-aging', () => import('../../../pages/accounting/reports/ap-aging'), 'reports-ap-aging', 500],
  ['ar-aging', () => import('../../../pages/accounting/reports/ar-aging'), 'reports-ar-aging', 500],
  ['audit-trail', () => import('../../../pages/accounting/reports/audit-trail'), 'reports-audit-trail', 403],
  ['balance-sheet', () => import('../../../pages/accounting/reports/balance-sheet'), 'reports-balance-sheet', 422],
  ['customer-reports', () => import('../../../pages/accounting/reports/customer-reports'), 'reports-customer', 500],
  ['income-statement', () => import('../../../pages/accounting/reports/income-statement'), 'reports-income-statement', 422],
  ['management-accounts', () => import('../../../pages/accounting/reports/management-accounts'), 'reports-management-accounts', 500],
  ['project-profitability', () => import('../../../pages/accounting/reports/project-profitability'), 'reports-project-profitability', 400],
  ['supplier-reports', () => import('../../../pages/accounting/reports/supplier-reports'), 'reports-supplier', 500],
  ['vat-return', () => import('../../../pages/accounting/reports/vat-return'), 'reports-vat-return', 409],
  ['disclosure-notes', () => import('../../../pages/accounting/reports/disclosure-notes'), '/api/accounting/disclosure-notes', 500],
  ['caseware-export', () => import('../../../pages/accounting/reports/caseware-export'), 'account-mappings', 500],
  ['my-reports', () => import('../../../pages/accounting/reports/my-reports'), 'custom-reports', 500],
];

describe('report pages show the server message when the load is refused', () => {
  for (const [name, loader, failUrl, status] of loadOnMount) {
    it(`${name} shows the server's message, not the generic fallback`, async () => {
      const msg = `D2 server says no: ${name} load refused`;
      script(failUrl, msg, status);
      const Page = (await loader()).default;
      render(<Page />);
      expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
    });
  }
});

it('bank-transactions shows the server message when the report is refused', async () => {
  const msg = 'D2 server says no: bank-transactions report refused';
  script('reports-bank-transactions', msg, 500, (u) => u.includes('chart-of-accounts')
    ? ok([{ id: 'a1', accountCode: '1100', accountName: 'Cheque', parentAccountId: null }]) : null);
  const Page = (await import('../../../pages/accounting/reports/bank-transactions')).default;
  render(<Page />);
  expect(await screen.findByText(new RegExp(msg))).toBeTruthy();
});
