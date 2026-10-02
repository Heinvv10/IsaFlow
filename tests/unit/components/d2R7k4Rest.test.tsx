/**
 * D2 round 7 (k4), part 2: rate curves, Flow wallet, PO/GRN selector, bank-tx query modal, payroll period bar, batch grid,
 * job detail, AFS document page (period lookup). A failed response is never dropped silently. REAL assertOk /
 * apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const router = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), replace: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/billing/TopUpModal', () => ({ TopUpModal: () => null }));
vi.mock('@/components/billing/UpgradeNudgeBanner', () => ({ UpgradeNudgeBanner: () => null }));
vi.mock('@/components/practice/JobStatusBadge', () => ({ JobStatusBadge: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import RateCurvesPage from '../../../pages/accounting/loans/rate-curves';
import FlowsPage from '../../../pages/accounting/settings/billing/flows';
import { PoGrnSelector } from '../../../src/components/accounting/suppliers/PoGrnSelector';
import { BankTxQueryModal } from '../../../src/components/accounting/BankTxQueryModal';
import { PayrollPeriodBar } from '../../../src/components/payroll/PayrollPeriodBar';
import BatchGridPage from '../../../pages/payroll/batches/[id]';
import JobDetailPage from '../../../pages/accounting/practice/jobs/[id]';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(log.error).mockClear(); router.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const calls = (method: string, part: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => String(u).includes(part) && ((i as RequestInit | undefined)?.method ?? 'GET') === method);

describe('rate curves', () => {
  const open = async () => { fireEvent.click(await screen.findByRole('button', { name: /new curve/i })); fireEvent.change(screen.getByPlaceholderText(/curve name/i), { target: { value: 'SA Prime' } }); fireEvent.click(screen.getByRole('button', { name: 'Create' })); };
  it('a refused create shows the server message and keeps the form open', async () => {
    script((u, m) => (m === 'POST' ? refuse() : ok([]))); render(<RateCurvesPage />); await open();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(screen.getByPlaceholderText(/curve name/i)).toBeTruthy();
  });
  it('an empty-500 create is a plain sentence and the form stays open', async () => {
    script((u, m) => (m === 'POST' ? empty500() : ok([]))); render(<RateCurvesPage />); await open();
    expect(await screen.findByText('Could not create the rate curve - try again')).toBeTruthy(); expectNoRawError();
    expect(screen.getByPlaceholderText(/curve name/i)).toBeTruthy();
  });
  it('a good create closes the form and reloads the curves', async () => {
    script(() => ok([])); render(<RateCurvesPage />); await open();
    await waitFor(() => expect(screen.queryByPlaceholderText(/curve name/i)).toBeNull());
    expect(calls('GET', 'loan-rate-curves').length).toBe(2);
  });
  it('a refused CSV upload says why in the curve status', async () => {
    script((u, m) => (m === 'POST' ? refuse() : u.includes('/points') ? ok([]) : ok([{ id: 'c1', name: 'Zeta Curve' }])));
    const { container } = render(<RateCurvesPage />); fireEvent.click(await screen.findByText('Zeta Curve'));
    await waitFor(() => expect(container.querySelector('input[type="file"]')).toBeTruthy());
    const file = new File(['2026-01-01,11.5'], 'p.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: async () => '2026-01-01,11.5' });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
});

describe('flow wallet', () => {
  const WALLET = { balance: 5, nudgeLevel: 'none', monthFlowsUsed: 0, autoTopupEnabled: false, autoTopupBundleId: null, paymentMethodToken: 'tok' };
  const base = (u: string) => (u.includes('/wallet') ? ok(WALLET) : u.includes('/ledger') ? ok({ entries: [] }) : ok([]));
  const toggle = async () => fireEvent.click(await screen.findByRole('checkbox'));
  it('a refused auto top-up change shows the server message and does not reload', async () => {
    script((u, m) => (m === 'PATCH' ? refuse() : base(u))); render(<FlowsPage />); await toggle();
    expect(await screen.findByText(MSG)).toBeTruthy(); expect(calls('GET', '/wallet').length).toBe(1);
  });
  it('an empty-500 change is a plain sentence', async () => {
    script((u, m) => (m === 'PATCH' ? empty500() : base(u))); render(<FlowsPage />); await toggle();
    expect(await screen.findByText('Could not save the auto top-up setting - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good change reloads the wallet', async () => {
    script((u, m) => (m === 'PATCH' ? ok({}) : base(u))); render(<FlowsPage />); await toggle();
    await waitFor(() => expect(calls('GET', '/wallet').length).toBe(2)); expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('po / grn selector', () => {
  const PO = { id: 'p1', po_number: 'PO-ZETA', order_date: '2026-01-01', status: 'open', total: 1 };
  const GRN = { id: 'g1', grn_number: 'GRN-ZETA', received_date: '2026-01-02', purchase_order_id: 'p1', po_number: 'PO-ZETA' };
  const mount = (over: Partial<Parameters<typeof PoGrnSelector>[0]> = {}) => {
    const props = { supplierId: 's1', selectedPoId: '', selectedGrnId: '', copyLines: false, onPoChange: vi.fn(), onGrnChange: vi.fn(), onCopyLinesChange: vi.fn(), onPoLineItems: vi.fn(), ...over };
    render(<PoGrnSelector {...props} />); return props;
  };
  it('a refused load shows the server message, an empty 500 a plain sentence; never "No open POs"', async () => {
    script(() => refuse()); mount(); expect(await screen.findByText(MSG)).toBeTruthy(); cleanup();
    script(() => empty500()); mount();
    expect(await screen.findByText('Could not load the purchase orders and GRNs - try again')).toBeTruthy();
    expect(screen.queryByText(/No open POs/)).toBeNull(); expectNoRawError();
  });
  it('a good load lists the POs with no error', async () => {
    script(() => ok({ pos: [PO], grns: [GRN] })); mount();
    expect(await screen.findByText('PO-ZETA (open)')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
  it('a failed GRN reload for a chosen PO says so and clears the stale GRNs', async () => {
    script((u) => (u.includes('purchaseOrderId') ? empty500() : ok({ pos: [PO], grns: [GRN] })));
    mount(); await screen.findByText('PO-ZETA (open)'); await screen.findByText(/GRN-ZETA/);
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'p1' } });
    expect(await screen.findByText('Could not load the GRNs for this purchase order - try again')).toBeTruthy();
    expect(screen.queryByText(/GRN-ZETA/)).toBeNull();
  });
  it('a failed copy of the PO lines says so and un-ticks the box', async () => {
    script((u) => (u.includes('/purchase-orders/p1') ? refuse() : ok({ pos: [PO], grns: [] })));
    const props = mount({ selectedPoId: 'p1' }); await screen.findByText('PO-ZETA (open)');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(props.onCopyLinesChange).toHaveBeenLastCalledWith(false); expect(props.onPoLineItems).not.toHaveBeenCalled();
  });
});

describe('bank transaction query modal', () => {
  const TX = { id: 't1', transactionDate: '2026-01-01', description: 'Zeta debit', amount: 10, status: 'unmatched' };
  const SETTINGS = { clientQueryWhatsapp: '27820000000', companyName: 'Acme' };
  const mount = () => render(<BankTxQueryModal tx={TX} onClose={vi.fn()} />);
  it('a failed settings load is said, with the number left to enter', async () => {
    script((u) => (u.includes('/settings') ? empty500() : ok([]))); mount();
    expect(await screen.findByText('Could not load the saved WhatsApp number - enter it below')).toBeTruthy(); expectNoRawError();
  });
  it('a failed prior-query check is said (it guards against a duplicate ask)', async () => {
    script((u) => (u.includes('/settings') ? ok(SETTINGS) : refuse())); mount();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('both loads failing are both said', async () => {
    script(() => empty500()); mount();
    expect(await screen.findByText(/saved WhatsApp number.*already queried/)).toBeTruthy();
  });
  it('a transport failure is a sentence, not an unhandled rejection', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new TypeError('fetch failed')); mount();
    expect(await screen.findByText('Could not load the query details - try again')).toBeTruthy(); expectNoRawError();
  });
  it('a good load shows the prior query and no error', async () => {
    script((u) => (u.includes('/settings') ? ok(SETTINGS) : ok([{ id: 'q1', status: 'sent', sent_at: '2026-01-02T10:00:00Z', to_number: '27820000000' }]))); mount();
    expect(await screen.findByText(/Already asked on/)).toBeTruthy(); expect(screen.queryByText(/Could not/)).toBeNull();
  });
  it('an empty-500 send is a plain sentence', async () => {
    script((u, m) => (m === 'POST' ? empty500() : u.includes('/settings') ? ok(SETTINGS) : ok([]))); mount();
    const send = await screen.findByRole('button', { name: /send/i }); await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText('Could not send the query - try again')).toBeTruthy(); expectNoRawError();
  });
});

describe('payroll period bar', () => {
  it('a failed response renders nothing and logs why (informational strip)', async () => {
    script(() => empty500()); const { container } = render(<PayrollPeriodBar />);
    await waitFor(() => expect(log.error).toHaveBeenCalled()); expect(container.textContent).toBe('');
  });
});

describe('payroll batch grid', () => {
  const BATCH = { batch: { id: 'b1', batchType: 'component_values', componentId: null, description: 'Zeta bonus', periodYear: 2026, periodMonth: 1, isRecurring: false, status: 'draft', lineCount: 0, totalAmount: 0 }, lines: [] };
  it('a failed employee list is said (adding lines needs it) while the batch still shows', async () => {
    router.query = { id: 'b1' };
    script((u) => (u.includes('/employees') ? empty500() : ok(BATCH))); render(<BatchGridPage />);
    expect(await screen.findByText('Could not load the employee list - try again')).toBeTruthy(); expectNoRawError();
    expect(screen.getByText(/Zeta bonus/)).toBeTruthy();
  });
  it('a good load has no error', async () => {
    router.query = { id: 'b1' };
    script((u) => (u.includes('/employees') ? ok([]) : ok(BATCH))); render(<BatchGridPage />);
    expect(await screen.findByText(/Zeta bonus/)).toBeTruthy(); expect(screen.queryByText(/Could not/)).toBeNull();
  });
});

describe('job detail', () => {
  const JOB = { id: 'j1', title: 'Zeta Job', status: 'new', priority: 'normal', practiceClientId: 'pc1', partnerId: 'u-1' };
  it('a failed team-member load is said, the job still shows', async () => {
    router.query = { id: 'j1' };
    script((u) => (u.includes('/practice/users') ? empty500() : ok(JOB))); render(<JobDetailPage />);
    expect(await screen.findByText('Could not load the team members - assignees show as IDs')).toBeTruthy();
    expect(screen.getAllByText('Zeta Job').length).toBeGreaterThan(0); expectNoRawError();
  });
});
