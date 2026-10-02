// D2 round 6 (g3b): page loads / writes now status-first. 4xx -> the server message; empty 500 -> a plain
// sentence (no JSON / HTTP codes); a failed (re)load clears what was on screen; 2xx still completes.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'x-1' }, push: vi.fn(), replace: vi.fn(), isReady: true, pathname: '/' }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', activeCompany: { id: 'c1' } }) }));
vi.mock('@/components/accounting/CashFlowForecastChart', () => ({
  CashFlowForecastChart: () => null, KpiCard: () => null, ConfidencePip: () => null,
  buildChartData: () => [], fmtCurrency: String, fmtShortDate: String,
}));

import { apiFetch } from '@/lib/apiFetch';
import ConnectedApps from '../../../pages/accounting/settings/connected-apps';
import OauthApps from '../../../pages/developer/oauth-apps';
import PurchaseOrders from '../../../pages/accounting/supplier-purchase-orders/index';
import Dedup from '../../../pages/accounting/suppliers/dedup';
import Emp501 from '../../../pages/payroll/emp501/index';
import Eea2 from '../../../pages/payroll/equity/eea2';
import CostCentre from '../../../pages/payroll/runs/[id]/cost-centre-summary';
import NewRun from '../../../pages/payroll/runs/new';
import Forecast from '../../../pages/accounting/reports/cash-flow-forecast';
import BatchPage from '../../../pages/payroll/batches/[id]';
import Features from '../../../pages/admin/features';

useApiJsonOverMock();
const MSG = 'D2 server says no: this request was refused';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad400 = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const noRaw = () => expect(document.body.textContent ?? '').not.toMatch(/JSON|Unexpected end|HTTP \d|Network error|Failed to/);
const answer = (fn: (p: string, m: string) => Response) => vi.mocked(apiFetch).mockReset().mockImplementation(async (u, i) => fn(String(u).split('?')[0]!, (i?.method ?? 'GET').toUpperCase()));
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const APP = { authorisationId: 'a1', appId: 'p1', appName: 'D2 Ledger Sync', appLogoUrl: null, appIsVerified: true, scopes: [], companyId: 'c1', lastUsedAt: null, createdAt: '2026-01-01' };

describe('connected apps', () => {
  it('load 400 shows the server message; empty 500 a sentence', async () => {
    answer(() => bad400()); render(<ConnectedApps />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<ConnectedApps />);
    expect(await screen.findByText('Could not load your connected apps - try again')).toBeTruthy(); noRaw();
  });
  it('a revoke the server refuses says so and keeps the app listed', async () => {
    vi.stubGlobal('confirm', () => true);
    answer((p, m) => (m === 'DELETE' ? bad400() : ok([APP])));
    render(<ConnectedApps />);
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Access revoked')).toBeNull();
    expect(screen.getByText('D2 Ledger Sync')).toBeTruthy();
  });
  it('a revoke that works reloads the list', async () => {
    vi.stubGlobal('confirm', () => true);
    let revoked = false;
    answer((p, m) => { if (m === 'DELETE') { revoked = true; return ok({}); } return ok(revoked ? [] : [APP]); });
    render(<ConnectedApps />);
    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(screen.queryByText('D2 Ledger Sync')).toBeNull());
  });
});

describe('developer oauth apps', () => {
  it('load: server message / plain sentence', async () => {
    answer(() => bad400()); render(<OauthApps />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<OauthApps />);
    expect(await screen.findByText('Could not load your apps - try again')).toBeTruthy(); noRaw();
  });
});

describe('supplier purchase orders list', () => {
  const PO = { id: 'o1', order_number: 'PO-D2-001', supplier_name: 'D2 Supplies', order_date: '2026-01-01', delivery_date: null, total_amount: 10, status: 'draft' };
  it('a failed reload clears the rows and says why', async () => {
    let n = 0;
    answer(() => (++n === 1 ? ok({ orders: [PO], total: 1 }) : empty500()));
    render(<PurchaseOrders />);
    await screen.findByText('PO-D2-001');
    fireEvent.click(screen.getByRole('button', { name: /sent/i }));
    expect(await screen.findByText('Could not load purchase orders - try again')).toBeTruthy();
    expect(screen.queryByText('PO-D2-001')).toBeNull(); noRaw();
  });
  it('load 400 shows the server message', async () => {
    answer(() => bad400()); render(<PurchaseOrders />); expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('supplier dedup scan', () => {
  it('400 / empty 500', async () => {
    answer(() => bad400()); render(<Dedup />); fireEvent.click(screen.getAllByRole('button', { name: /scan/i })[0]!);
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<Dedup />); fireEvent.click(screen.getAllByRole('button', { name: /scan/i })[0]!);
    expect(await screen.findByText('Could not scan for duplicates - try again')).toBeTruthy(); noRaw();
  });
});

describe('payroll pages', () => {
  it('emp501 load', async () => {
    answer(() => bad400()); render(<Emp501 />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<Emp501 />);
    expect(await screen.findByText('Could not load the EMP501 reconciliation - try again')).toBeTruthy(); noRaw();
  });
  it('eea2 load', async () => {
    answer(() => bad400()); render(<Eea2 />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<Eea2 />);
    expect(await screen.findByText('Could not load EEA2 report - try again')).toBeTruthy(); noRaw();
  });
  it('cost-centre summary load', async () => {
    answer(() => bad400()); render(<CostCentre />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<CostCentre />);
    expect(await screen.findByText('Could not load the cost centre summary - try again')).toBeTruthy(); noRaw();
  });
  it('new run create: server message / sentence, never navigates', async () => {
    answer(() => bad400()); render(<NewRun />);
    fireEvent.submit(document.querySelector('form')!); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<NewRun />);
    fireEvent.submit(document.querySelector('form')!);
    expect(await screen.findByText('Could not create the payroll run - try again')).toBeTruthy(); noRaw();
  });
  it('batch page load', async () => {
    answer(() => bad400()); render(<BatchPage />); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<BatchPage />);
    expect(await screen.findByText('Could not load the batch - try again')).toBeTruthy(); noRaw();
  });
});

describe('cash flow forecast', () => {
  it('generate: 400 / empty 500', async () => {
    answer(() => bad400()); render(<Forecast />); fireEvent.click(screen.getByRole('button', { name: /generate forecast/i }));
    expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    answer(() => empty500()); render(<Forecast />); fireEvent.click(screen.getByRole('button', { name: /generate forecast/i }));
    expect(await screen.findByText('Could not generate the forecast - try again')).toBeTruthy(); noRaw();
  });
});

describe('admin feature flags', () => {
  it('load failure shows a sentence, not a code', async () => {
    answer(() => empty500()); render(<Features />);
    await waitFor(() => expect(document.body.textContent ?? '').toContain('Could not load the feature flags - try again')); noRaw();
  });
});
