/**
 * d2 census group 7 (b): admin/dashboard/recurring loads and the modal/upload components that read
 * `res.json()` without a `res.ok` check. 400 envelope, empty 500 and 200, through the real apiFetch helpers.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, NO_RAW, respond, serveRoutes, type Kind } from '../helpers/d2CensusG7Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/StatsCard', () => ({ StatsCard: () => null }));
vi.mock('@/components/admin/charts/TrafficTimeseriesChart', () => ({ TrafficTimeseriesChart: () => null }));
vi.mock('@/components/accounting/dashboard/OverviewTables', () => ({ OverviewTables: () => null }));
vi.mock('@/components/accounting/dashboard/TodoWidget', () => ({ TodoWidget: () => null }));
vi.mock('@/components/accounting/dashboard/WorkbenchSection', () => ({ WorkbenchSection: () => null }));
vi.mock('@/components/accounting/banking/NoBankAccountWarning', () => ({ NoBankAccountWarning: () => null }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } })); // stable: a fresh object per render refetches forever
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast, default: toast }));

import RecurringTransactionsPage from '../../../pages/accounting/recurring-transactions';
import AdminWebAnalytics from '../../../pages/admin/web-analytics';
import { OverviewTab } from '@/components/accounting/dashboard/OverviewTab';
import { ConvertTrialModal } from '@/components/admin/ConvertTrialModal';
import { AddSubsidiaryModal } from '@/components/accounting/consolidation/AddSubsidiaryModal';
import { UploadZone } from '@/components/accounting/document-capture/UploadZone';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const plain = (re: RegExp) => async () => { expect(await screen.findByText(re)).toBeTruthy(); expect(NO_RAW()).toBe(true); };

const template = { id: 't1', name: 'D2 Rent Template', entityType: 'journal_entry', frequency: 'monthly', nextRunDate: null,
  lastRunDate: null, isActive: true, autoPost: false, templateData: {} };
const kpis = {
  revenue: { total: 7654321, priorTotal: 0, changePercent: 1 }, expenses: { total: 0, priorTotal: 0 },
  grossProfit: { amount: 0, margin: 0 }, netProfit: { amount: 0, margin: 0 }, cash: { total: 0, priorTotal: 0, change: 0 },
  receivables: { total: 0, overdue: 0, avgDebtorDays: 0 }, payables: { total: 0, overdue: 0, avgCreditorDays: 0 },
  activity: { invoicesIssued: 0, paymentsReceived: 0, journalsPosted: 0 },
};
const site = { id: 'w1', name: 'D2 Analytics Site', tracking_id: 't', domain: null, category: 'app', company_id: null };

describe('recurring transactions list', () => {
  const go = (kind: Kind) => { serveRoutes([['/api/accounting/recurring-transactions', () => respond(kind, [template])]]); render(<RecurringTransactionsPage />); };
  it('shows the server message on a 400', async () => { go('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => { go('empty500'); await plain(/could not load templates/i)(); });
  it('renders the templates on a 200', async () => { go('ok'); expect(await screen.findByText('D2 Rent Template')).toBeTruthy(); });
});

describe('web analytics website list', () => {
  const go = (kind: Kind) => {
    serveRoutes([
      ['/web/websites', () => respond(kind, { websites: [site] })],
      ['/web/summary', () => respond('bad')], ['/web/realtime', () => respond('bad')],
    ]);
    render(<AdminWebAnalytics />);
  };
  it('shows the server message on a 400', async () => { go('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => { go('empty500'); await plain(/could not load websites/i)(); });
  it('renders the website on a 200', async () => { go('ok'); expect(await screen.findByText(/D2 Analytics Site/)).toBeTruthy(); });
});

describe('accounting dashboard KPIs', () => {
  const go = (kind: Kind) => { serveRoutes([['/api/accounting/kpi-dashboard', () => respond(kind, { kpis, hasBankAccount: true })]]); render(<OverviewTab />); };
  it('shows the server message on a 400', async () => { go('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => { go('empty500'); await plain(/could not load the dashboard figures/i)(); });
  it('renders the figures on a 200', async () => { go('ok'); expect(await screen.findByText('R 7.7M')).toBeTruthy(); });
});

describe('convert trial modal plan list', () => {
  const plan = { id: 'pl1', name: 'D2 Growth Plan', code: 'G', monthly_price_cents: 10000, currency: 'ZAR' };
  const go = (kind: Kind) => { serveRoutes([['/api/admin/billing/plans', () => respond(kind, [plan])]]);
    render(<ConvertTrialModal companyId="c1" companyName="Acme" onClose={vi.fn()} onConverted={vi.fn()} />); };
  it('shows the server message on a 400', async () => { go('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); });
  it('shows a plain sentence on an empty 500', async () => { go('empty500'); await plain(/could not load plans/i)(); });
  it('lists the plan on a 200', async () => { go('ok'); expect((await screen.findAllByText(/D2 Growth Plan/)).length).toBeGreaterThan(0); });
});

describe('add subsidiary modal', () => {
  const go = (kind: Kind) => {
    serveRoutes([['/api/accounting/consolidation/companies', () => respond(kind, { items: [{ id: 'D2-SUB' }] })]]);
    const onSaved = vi.fn(); const onClose = vi.fn();
    const { container } = render(<AddSubsidiaryModal onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText(/xxxxxxxx/), { target: { value: 'child-1' } });
    fireEvent.submit(container.querySelector('form')!);
    return { onSaved, onClose };
  };
  it('shows the server message on a 400', async () => { const { onSaved } = go('bad'); expect(await screen.findByText(new RegExp(MSG))).toBeTruthy(); expect(onSaved).not.toHaveBeenCalled(); });
  it('shows a plain sentence on an empty 500', async () => { go('empty500'); await plain(/could not add the subsidiary/i)(); });
  it('hands the saved list back on a 200', async () => { const { onSaved } = go('ok'); await waitFor(() => expect(onSaved).toHaveBeenCalledWith([{ id: 'D2-SUB' }])); });
});

describe('document upload zone', () => {
  const go = (kind: Kind) => {
    serveRoutes([['/api/accounting/document-capture', () => respond(kind, { document: { id: 'D2-DOC' }, extracted: {} })]]);
    const props = { isUploading: false, isDragging: false, onDraggingChange: vi.fn(), onUploadComplete: vi.fn(),
      onUploadError: vi.fn(), onUploadStart: vi.fn(), onRefreshList: vi.fn() };
    const { container } = render(<UploadZone {...props} />);
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'inv.pdf', { type: 'application/pdf' })] } });
    return props;
  };
  it('reports the server message on a 400', async () => {
    const p = go('bad');
    await waitFor(() => expect(p.onUploadError).toHaveBeenCalledWith(MSG));
    expect(toast.error).toHaveBeenCalledWith(MSG);
  });
  it('reports a plain sentence on an empty 500', async () => {
    const p = go('empty500');
    await waitFor(() => expect(p.onUploadError).toHaveBeenCalled());
    const msg = String(p.onUploadError.mock.calls[0]![0]);
    expect(msg).toMatch(/could not upload the document/i);
    expect(msg).not.toMatch(/JSON|Unexpected end/);
  });
  it('hands the result back on a 200', async () => {
    const p = go('ok');
    await waitFor(() => expect(p.onUploadComplete).toHaveBeenCalledWith({ document: { id: 'D2-DOC' }, extracted: {} }));
    expect(toast.success).toHaveBeenCalled();
  });
});

