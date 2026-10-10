/**
 * A posting that drops a cost-centre pick returns `warnings`, and the screen
 * that asked must show them (PR #688 round 5: all five showed nothing, so a
 * bill, a claim or a recurring journal posted without its cost centre and
 * nobody was told). Rendered and clicked, not grepped: the defect was a
 * response field no handler read.
 *
 *   supplier invoice detail · supplier invoice bulk bar · recurring
 *   transactions · expense claim  -> the warning toast (as the late-claim notice)
 *   recurring journals -> its own inline notice, beside "held for approval"
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
const company = vi.hoisted(() => ({ companyRole: 'owner', activeCompany: { id: 'co-1', name: 'Co' } }));
vi.mock('next/router', () => ({
  useRouter: () => ({ isReady: true, pathname: '/accounting', query: route.query, push: vi.fn(), events: { on: () => {}, off: () => {} } }),
}));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';
import RecurringJournalsPage from '../../../pages/accounting/recurring-journals/index';
import RecurringTransactionsPage from '../../../pages/accounting/recurring-transactions';
import ExpenseClaimPage from '../../../pages/accounting/expenses/[id]';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

const INACTIVE = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const TITLE = 'Posted — 1 cost centre was not applied';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
/** Serve by URL fragment, first match wins; anything else is an empty success. */
function serve(routes: Array<[string, unknown]>) {
  vi.mocked(apiFetch).mockImplementation(async (url) => ok(routes.find(([part]) => String(url).includes(part))?.[1] ?? {}));
}
const warned = () => expect(notify.warning).toHaveBeenCalledWith(TITLE, INACTIVE);

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); route.query = {}; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('supplier invoice detail — Approve & Post GL', () => {
  const invoice = {
    id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies', status: 'draft', invoiceDate: '2026-03-01',
    dueDate: '2026-03-31', paymentTerms: '30 days', subtotal: 1000, taxAmount: 150, taxRate: 15, totalAmount: 1150,
    balance: 1150, notes: '', items: [], approval: { state: 'not_required', enforced: false, requiredRole: null, ruleName: null, requestId: null },
  };
  const approve = async (answer: unknown) => {
    route.query = { invoiceId: 'inv-1' };
    serve([['supplier-invoices-action', answer], ['supplier-invoices-detail', invoice]]);
    render(<SupplierInvoiceDetailPage />);
    fireEvent.click(await screen.findByText('Approve & Post GL'));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('supplier-invoices-detail')).length).toBe(2));
  };
  it('says which cost centre was not applied', async () => {
    await approve({ ...invoice, status: 'approved', warnings: [INACTIVE] });
    warned();
  });
  it('says nothing when every pick landed', async () => {
    await approve({ ...invoice, status: 'approved' });
    expect(notify.warning).not.toHaveBeenCalled();
  });
});

describe('supplier invoice bulk bar — Approve', () => {
  const run = async (results: unknown[]) => {
    vi.stubGlobal('confirm', () => true);
    serve([['supplier-invoices-bulk-action', { total: results.length, succeeded: results.length, failed: 0, results }]]);
    const onComplete = vi.fn(async () => {});
    render(<BulkActionBar selected={new Set(['b1', 'b2'])} busy={null} onBusyChange={() => {}} onError={() => {}}
      onComplete={onComplete} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
  };
  it('says which cost centre was not applied, once for the batch', async () => {
    await run([{ invoiceId: 'b1', ok: true, warnings: [INACTIVE] }, { invoiceId: 'b2', ok: true, warnings: [INACTIVE] }]);
    await waitFor(warned);
    expect(notify.warning).toHaveBeenCalledTimes(1);
  });
  it('says nothing when no bill carried a warning', async () => {
    await run([{ invoiceId: 'b1', ok: true }, { invoiceId: 'b2', ok: true }]);
    expect(notify.warning).not.toHaveBeenCalled();
  });
});

describe('recurring journals — Generate Now', () => {
  const template = { id: 'rj-1', templateName: 'Monthly rent accrual', frequency: 'monthly', nextRunDate: '2026-06-01',
    runCount: 0, status: 'active', totalAmount: 1000, lines: [] };
  const generate = async (answer: unknown) => {
    serve([['recurring-journals-action', answer], ['recurring-journals', { items: [template] }], ['chart-of-accounts', { accounts: [] }]]);
    render(<RecurringJournalsPage />);
    await screen.findByText('Monthly rent accrual');
    fireEvent.click(screen.getByTitle('Generate Now'));
  };
  it('shows the warning in the page notice', async () => {
    await generate({ journalId: 'je-1', heldForApproval: [], warnings: [INACTIVE] });
    expect(await screen.findByText(INACTIVE)).toBeTruthy();
  });
  it('shows it beside a held-for-approval notice, not instead of it', async () => {
    await generate({ journalId: 'je-1', heldForApproval: ['je-1'], warnings: [INACTIVE] });
    expect(await screen.findByText(`1 journal held for approval — left as a draft until approved. ${INACTIVE}`)).toBeTruthy();
  });
  it('shows no notice for a clean run', async () => {
    await generate({ journalId: 'je-1', heldForApproval: [] });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).endsWith('/recurring-journals')).length).toBe(2));
    expect(screen.queryByText(/not applied|held for approval/)).toBeNull();
  });
});

describe('recurring transactions — Run Now', () => {
  const template = { id: 't1', name: 'Rent template', entityType: 'journal_entry', frequency: 'monthly', nextRunDate: null,
    lastRunDate: null, isActive: true, autoPost: false, templateData: {} };
  const runNow = async (answer: unknown) => {
    serve([['recurring-transactions-execute', answer], ['recurring-transactions', [template]]]);
    render(<RecurringTransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /run now/i }));
    expect(await screen.findByText(/Created/)).toBeTruthy();
  };
  it('says which cost centre was not applied', async () => {
    await runNow({ entityType: 'journal_entry', entityId: 'je-1', posted: false, heldForApproval: [], warnings: [INACTIVE] });
    warned();
  });
  it('says nothing for a clean run', async () => {
    await runNow({ entityType: 'journal_entry', entityId: 'je-1', posted: false, heldForApproval: [] });
    expect(notify.warning).not.toHaveBeenCalled();
  });
});

describe('expense claim — Post to GL', () => {
  const claim = (status: string, extra: object = {}) => ({
    id: 'c1', claimNumber: 'EXP-0001', claimDate: '2026-06-22', employeeId: 'e1', title: 'Stationery', description: null, status,
    totalAmount: 115, totalVat: 15, approvedBy: null, approvedAt: null, rejectionReason: null, postedJeId: null, postedAt: null,
    submittedAt: '2026-06-22', lines: [], ...extra,
  });
  const post = async (posted: unknown) => {
    route.query = { id: 'c1' };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(ok({ claim: claim('approved') }))
      .mockResolvedValueOnce(ok({ accounts: [{ id: 'a1', code: '2300', name: 'Reimbursements' }] }))
      .mockResolvedValueOnce(ok(posted));
    render(<ExpenseClaimPage />);
    fireEvent.click(await screen.findByText('Post to GL'));
    await screen.findAllByRole('option', { name: '2300 — Reimbursements' });
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
  };
  it('says which line\'s cost centre was not applied', async () => {
    await post({ claim: claim('posted', { warnings: [INACTIVE] }) });
    await waitFor(warned);
  });
  it('does not mistake the VAT advice (data.warnings) for a dropped cost centre', async () => {
    await post({ claim: claim('posted'), warnings: ['Input VAT on entertainment is denied.'] });
    await screen.findByText('Claim posted').catch(() => null);
    expect(notify.warning).not.toHaveBeenCalled();
  });
});
