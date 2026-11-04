/**
 * Budgets P5-2: approving a bill that meets a budget opens the approve dialog (spec §5), rendered
 * through the real page: the per-slice remaining table, a required reason in warn, Override for an
 * owner or admin in block, and what is sent to the action route.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
const role = vi.hoisted(() => ({ current: 'owner' }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' } }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/accounting/ap/ThreeWayMatchPanel', () => ({ ThreeWayMatchPanel: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierInvoiceDetailPage from '../../../pages/accounting/supplier-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const draft = {
  id: 'inv-1', invoiceNumber: 'INV-001', supplierName: 'Acme Supplies', status: 'draft',
  invoiceDate: '2026-06-12', dueDate: '2026-07-12', paymentTerms: '30 days', subtotal: 1500, taxAmount: 225,
  taxRate: 15, totalAmount: 1725, balance: 1725, notes: '', items: [],
};
const ok = (data: unknown) => ({ ok: true, json: () => Promise.resolve({ success: true, data }) });
const line = (over: boolean, budget: number | null, accountLabel: string) => ({
  glAccountId: accountLabel, month: '2026-06', grain: budget === null ? null : 'cc1', cc1Id: 'ft', cc2Id: null, buId: null,
  unassigned: false, budget, actual: 200, committed: 0, remaining: budget === null ? null : budget - 200, amount: 1500, over,
  accountLabel, sliceLabel: 'FT Fibertime',
});
const preview = (policy: string) => ok({ policy, checks: true, overCount: 1, lines: [line(true, 1000, '6100 Opex'), line(false, null, '6300 Unbudgeted')] });
const actionBody = () => {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/accounting/supplier-invoices-action');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

async function openDialog(policy: string) {
  fetchMock.mockResolvedValueOnce(ok(draft));
  render(<SupplierInvoiceDetailPage />);
  fetchMock.mockResolvedValueOnce(preview(policy));
  fireEvent.click(await screen.findByText('Approve & Post GL'));
  await screen.findByText('Approve against the budget');
}

describe('supplier invoice page — budget approve dialog', () => {
  beforeEach(() => { fetchMock.mockReset(); role.current = 'owner'; });

  it('warn: shows the remaining table, and approves only with a reason, which it sends', async () => {
    await openDialog('warn');
    expect(screen.getByText('6100 Opex')).toBeTruthy();
    expect(screen.getAllByText('No budget').length).toBeGreaterThan(0); // the cards and the table (CSS shows one)
    expect(screen.getByText(/One line is over budget/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Stock for the year-end run' } });
    expect(approve.disabled).toBe(false);
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fireEvent.click(approve);
    await waitFor(() => expect(actionBody()).toEqual({ action: 'approve', invoiceId: 'inv-1', budgetReason: 'Stock for the year-end run' }));
    await waitFor(() => expect(screen.queryByText('Approve against the budget')).toBeNull());
  });

  it('block, a manager: refused, no override offered', async () => {
    role.current = 'manager';
    await openDialog('block');
    expect(screen.getByText(/Only an owner or admin can override it/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Override and approve' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('block, an owner: Override with a reason sends budgetOverride and the reason', async () => {
    await openDialog('block');
    const go = screen.getByRole('button', { name: 'Override and approve' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(go.disabled).toBe(true); // a reason is still required
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Board approved' } });
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fetchMock.mockResolvedValueOnce(ok({ ...draft, status: 'approved' }));
    fireEvent.click(go);
    await waitFor(() => expect(actionBody()).toEqual({ action: 'approve', invoiceId: 'inv-1', budgetReason: 'Board approved', budgetOverride: true }));
  });

  it('warn preview, then a 409 BUDGET_EXCEEDED (the policy became block): the dialog turns to block and offers Override (review R1)', async () => {
    await openDialog('warn');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: {
      code: 'CONFLICT', message: 'Over budget — approval refused: 6100 Opex.', details: { code: 'BUDGET_EXCEEDED', lines: [] } } }), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Override and approve' })).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
    expect(screen.getByText('6100 Opex')).toBeTruthy(); // the preview's lines are kept
    expect(screen.getAllByRole('alert').some((a) => /refused unless you override/.test(a.textContent ?? ''))).toBe(true); // R8: a blocking refusal is an alert
  });

  it('a refusal from the server keeps the dialog open with its words', async () => {
    await openDialog('warn');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: {
      code: 'CONFLICT', message: 'Over budget — approval refused: 6100 Opex.', details: { code: 'BUDGET_EXCEEDED', lines: [] } } }), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Over budget — approval refused: 6100 Opex.')).toBeTruthy();
    expect(screen.getByText('Approve against the budget')).toBeTruthy();
  });
});
