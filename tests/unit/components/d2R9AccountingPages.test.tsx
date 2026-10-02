// D2 round 9 (pages/accounting): findings from the uiux review that had no test.
//   bank-feeds: the extension's own sentence survives, a failed list is an error with Retry (not "No connections");
//   afs/[documentId]: a failed load says so; migration/index: a failed session load offers Retry, not the source picker;
//   migration/customers: a CSV parse error is a plain sentence; far-report: a 2xx without data clears the old report;
//   customers/[customerId]: a failed reload A->B must not keep showing A; capture/settings: the chase switch is off
//   while its settings are not loaded; group/index, practice/jobs/new + [id], report-packs: failed loads are shown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', push: vi.fn(async () => true) }));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});
vi.mock('papaparse', () => ({ default: { parse: (_f: unknown, opts: { error: (e: { message: string }) => void }) => opts.error({ message: 'Invalid quote at row 7' }) } }));
vi.mock('@/components/accounting/afs/AfsOverviewTab', () => ({ AfsOverviewTab: () => <p>TAB Overview</p> }));
vi.mock('@/components/accounting/afs/AfsNotesTab', () => ({ AfsNotesTab: () => null }));
vi.mock('@/components/accounting/afs/AfsStatementsTab', () => ({ AfsStatementsTab: () => null }));
vi.mock('@/components/accounting/afs/AfsReviewTab', () => ({ AfsReviewTab: () => null }));
vi.mock('@/components/accounting/afs/AfsExportTab', () => ({ AfsExportTab: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import BankFeedsPage from '../../../pages/accounting/bank-feeds/index';
import AfsDocumentPage from '../../../pages/accounting/afs/[documentId]/index';
import MigrationHubPage from '../../../pages/accounting/migration/index';
import MigrationCustomersPage from '../../../pages/accounting/migration/customers';
import FarReportPage from '../../../pages/accounting/assets/far-report';
import CustomerDetailPage from '../../../pages/accounting/customers/[customerId]';
import CaptureSettingsPage from '../../../pages/accounting/capture/settings';
import GroupDashboardPage from '../../../pages/accounting/group/index';
import NewPracticeJobPage from '../../../pages/accounting/practice/jobs/new';
import JobDetailPage from '../../../pages/accounting/practice/jobs/[id]';
import ReportPacksPage from '../../../pages/accounting/reports/report-packs';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); router.query = {}; router.isReady = true; });
afterEach(() => { cleanup(); document.querySelectorAll('[data-toast]').forEach(n => n.remove()); });

const EXT_CONN = { id: 'k1', companyId: 'c1', provider: 'extension', accountName: 'ABSA Cheque', status: 'active', config: {} };

describe('bank feeds', () => {
  it('keeps the extension\'s own sentence when it refuses the sync', async () => {
    serve(on('GET', '/bank-feeds', () => ok({ items: [EXT_CONN] })));
    const reply = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; requestId?: string } | null;
      if (d?.type !== 'isaflow-bank-ext-sync') return;
      window.postMessage({ source: 'isaflow-bank-extension', type: 'isaflow-bank-ext-sync-reply', requestId: d.requestId, ok: false, error: 'Your ABSA session has expired - sign in again' }, '*');
    };
    window.addEventListener('message', reply);
    try {
      render(<BankFeedsPage />);
      fireEvent.click(await screen.findByRole('button', { name: /How to import/ }));
      await waitFor(() => expect([...document.querySelectorAll('[data-toast]')].map(n => n.textContent)).toContain('Your ABSA session has expired - sign in again'));
      expect(document.body.textContent).not.toContain('Could not sync the connection');
    } finally { window.removeEventListener('message', reply); }
  });

  it('a failed connections load is an error with Retry, not "No Bank Feed Connections"', async () => {
    let fail = true;
    serve((u, m) => (fail && m === 'GET' && u.includes('/bank-feeds') ? empty500() : undefined), on('GET', '/bank-feeds', () => ok({ items: [EXT_CONN] })));
    render(<BankFeedsPage />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load the bank feed connections - try again'));
    expect(screen.queryByText('No Bank Feed Connections')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('ABSA Cheque')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('afs document page', () => {
  it('a failed document load shows a message instead of a bare page', async () => {
    serve(on('GET', '/afs/doc-1', () => refuse()));
    render(<AfsDocumentPage documentId="doc-1" periodStart="2026-01-01" periodEnd="2026-12-31" periodError={null} />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty 500 is a plain sentence', async () => {
    serve(on('GET', '/afs/doc-1', empty500));
    render(<AfsDocumentPage documentId="doc-1" periodStart="2026-01-01" periodEnd="2026-12-31" periodError={null} />);
    expect(await screen.findByText('Could not load the document - try again')).toBeTruthy();
    expectNoJargon();
  });
});

describe('migration hub', () => {
  it('a failed session load offers Retry and never the source picker', async () => {
    let fail = true;
    serve((u, m) => (fail && m === 'GET' && u.includes('migration/session') ? empty500() : undefined), on('GET', 'migration/session', () => ok({ session: null })));
    render(<MigrationHubPage />);
    expect(await screen.findByText('Could not load your migration - try again')).toBeTruthy();
    expect(screen.queryByText(/Choose Your Source System/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Choose Your Source System/)).toBeTruthy();
    expect(screen.queryByText('Could not load your migration - try again')).toBeNull();
  });
});

describe('migration csv upload', () => {
  it('a CSV parse error is a plain sentence, not the parser text', async () => {
    serve();
    const { container } = render(<MigrationCustomersPage />);
    const file = new File(['a,b'], 'c.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText('Could not read the CSV file - check it is a valid CSV and try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/CSV parse error|Invalid quote/);
  });
});

describe('fixed asset register report', () => {
  const asset = { assetNumber: 'FA-1', assetName: 'D2 Excavator', categoryCode: 'PE', categoryName: 'Plant', ias16Group: 'Plant', taxCode: 'T', taxLifeYears: 5, policyLifeYears: 5,
    residualPct: 0, status: 'active', belowThreshold: false, policyCost: 100, policyAccDep: 10, policyCA: 90, policyCurrentDep: 10, policyProfitLoss: 0, taxCost: 100, taxAccDep: 10, taxCA: 90, taxCurrentDep: 10, taxProfitLoss: 0, deferredTax: 0 };
  const totals = { policyCost: 100, policyAccDep: 10, policyCA: 90, taxCost: 100, taxAccDep: 10, taxCA: 90, deferredTax: 0 };
  it('a 2xx without data clears the old report and says so in a plain sentence', async () => {
    let n = 0;
    serve(on('GET', 'far-report?', () => (n++ === 0
      ? ok({ asAt: '2026-01-01', assets: [asset], totals })
      : new Response(JSON.stringify({ success: false, error: 'raw boom' }), { status: 200 }))));
    render(<FarReportPage />);
    expect(await screen.findByText('D2 Excavator')).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2025-06-30' } });
    expect(await screen.findByText('Could not load the report - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Excavator')).toBeNull();
    expect(document.body.textContent).not.toMatch(/raw boom|Failed to load report/);
  });
});

describe('customer detail', () => {
  const cust = (id: string, name: string) => ({ id, name, email: null, phone: null, contact_person: null, vat_number: null, registration_number: null, payment_terms: 30, credit_limit: 0, is_active: true, created_at: '2026-01-01' });
  it('a failed reload A -> B does not keep showing customer A under B', async () => {
    router.query = { customerId: 'a' };
    serve((u) => (u.includes('id=b') ? empty500() : u.includes('id=a') ? ok(cust('a', 'Alpha Traders')) : undefined));
    const { rerender } = render(<CustomerDetailPage />);
    expect((await screen.findAllByText('Alpha Traders')).length).toBeGreaterThan(0);
    router.query = { customerId: 'b' };
    rerender(<CustomerDetailPage />);
    expect(await screen.findByText('Could not load customer - try again')).toBeTruthy();
    expect(screen.queryByText('Alpha Traders')).toBeNull();
  });
  it('a good reload B clears the earlier error', async () => {
    router.query = { customerId: 'a' };
    serve((u) => (u.includes('id=a') ? empty500() : u.includes('id=b') ? ok(cust('b', 'Beta Traders')) : undefined));
    const { rerender } = render(<CustomerDetailPage />);
    expect(await screen.findByText('Could not load customer - try again')).toBeTruthy();
    router.query = { customerId: 'b' };
    rerender(<CustomerDetailPage />);
    expect((await screen.findAllByText('Beta Traders')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Could not load customer - try again')).toBeNull();
  });
});

describe('capture settings chase switch', () => {
  it('is disabled while the chase settings failed to load, enabled once loaded', async () => {
    serve(on('GET', 'chase-settings', empty500), on('GET', 'inbox-address', () => ok({ inbox: { id: 'i', address: 'x@capture.test' } })));
    const { unmount } = render(<CaptureSettingsPage />);
    const sw = await screen.findByRole('switch');
    await waitFor(() => expect(document.body.textContent).toContain('Could not load the chase settings - try again'));
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    unmount();
    serve(on('GET', 'chase-settings', () => ok({ chaseAutoSendEnabled: false, chaseGraceDays: 3, whatsappChaseEnabled: false })), on('GET', 'inbox-address', () => ok({ inbox: { id: 'i', address: 'x@capture.test' } })));
    render(<CaptureSettingsPage />);
    await waitFor(() => expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('group dashboard', () => {
  it('a refused groups load shows the server message', async () => {
    serve(on('GET', 'company-groups', () => refuse()));
    render(<GroupDashboardPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty 500 is a plain sentence', async () => {
    serve(on('GET', 'company-groups', empty500));
    render(<GroupDashboardPage />);
    expect(await screen.findByText('Could not load the company groups - try again')).toBeTruthy();
    expectNoJargon();
  });
  it('a refused dashboard load shows the server message', async () => {
    serve(on('GET', 'company-groups', () => ok([{ id: 'g1', name: 'Group One', memberCount: 1, holdingCompanyName: null }])), on('GET', 'consolidated-reports', () => refuse()));
    render(<GroupDashboardPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('new practice job', () => {
  it('a failed clients list says so instead of an empty required dropdown', async () => {
    serve(on('GET', 'practice/clients', empty500));
    render(<NewPracticeJobPage />);
    expect(await screen.findByText('Could not load the clients - try again')).toBeTruthy();
  });
  it('a refused categories list shows the server message', async () => {
    serve(on('GET', 'job-categories', () => refuse()));
    render(<NewPracticeJobPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('a failed users list says so', async () => {
    serve(on('GET', 'practice/users', empty500));
    render(<NewPracticeJobPage />);
    expect(await screen.findByText('Could not load the users - try again')).toBeTruthy();
  });
  it('good lists show no error and fill the dropdown', async () => {
    serve(on('GET', 'practice/clients', () => ok([{ id: 'p1', legalName: 'D2 Client Ltd' }])));
    render(<NewPracticeJobPage />);
    expect(await screen.findByText('D2 Client Ltd')).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});

describe('practice job detail tabs', () => {
  const JOB = { id: 'j1', title: 'D2 Job', status: 'new', priority: 'normal', practiceClientId: 'p1', dueDate: null, partnerId: null, preparerId: null };
  it('a failed tasks load shows its error with Retry and is retried, never an empty list', async () => {
    router.query = { id: 'j1' };
    let fail = true;
    serve((u, m) => (fail && m === 'GET' && u.includes('practice/tasks') ? empty500() : undefined),
      on('GET', 'practice/jobs/j1', () => ok(JOB)), on('GET', 'practice/tasks', () => ok({ tasks: [{ id: 't1', title: 'D2 task', status: 'pending', priority: 'normal', assignedTo: null, dueDate: null }] })));
    render(<JobDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'tasks' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load the tasks - try again'));
    expect(screen.queryByText('No tasks yet')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('D2 task')).toBeTruthy();
  });
  it('a failed time load shows its error and is retried from the Retry button', async () => {
    router.query = { id: 'j1' };
    let fail = true;
    serve((u, m) => (fail && m === 'GET' && u.includes('time-entries') ? refuse() : undefined),
      on('GET', 'practice/jobs/j1', () => ok(JOB)), on('GET', 'time-entries', () => ok({ entries: [] })));
    render(<JobDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'time' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(MSG));
    expect(screen.queryByText('No time entries for this job')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No time entries for this job')).toBeTruthy();
  });
});

describe('report packs', () => {
  it.each([403, 500])('a %i (not a 429) is shown, not a blank screen', async (status) => {
    serve(on('GET', 'reports-pack', () => (status === 403 ? refuse(MSG, 403) : empty500())));
    render(<ReportPacksPage />);
    await waitFor(() => expect(screen.getAllByRole('alert').map(a => a.textContent).join('|')).toContain(status === 403 ? MSG : 'Could not load the report pack - try again'));
  });
});
