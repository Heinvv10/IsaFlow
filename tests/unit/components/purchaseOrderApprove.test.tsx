/**
 * Budgets P5-3 (spec §5): the purchase order's Approve button. It previews the PO's budget
 * (POST /api/accounting/budgets/remaining { purchaseOrderId }) and opens the bills' approve dialog worded for an
 * order when a line meets a budget; the reason (warn) or override (block, owner/admin) goes to
 * POST /api/accounting/purchase-orders/[id]/approve. A PO meeting no budget is approved at once; a line with no
 * account reads "No account" / "No budget"; a server refusal keeps the dialog open with its words.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const role = vi.hoisted(() => ({ value: 'manager' }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.value, activeCompany: { id: 'c1' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import { PurchaseOrderApproveButton } from '@/components/accounting/purchase-orders/PurchaseOrderApproveButton';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const PO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PREVIEW_URL = '/api/accounting/budgets/remaining';
const APPROVE_URL = `/api/accounting/purchase-orders/${PO}/approve`;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { success: true, data } : data), { status });
const bodyOf = (url: string) => {
  const call = vi.mocked(apiFetch).mock.calls.find(([u]) => u === url);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};
const line = (o: Partial<BudgetCheckLine>): BudgetCheckLine => ({
  glAccountId: 'acc', month: '2026-06', grain: 'cc1', cc1Id: 'ft', cc2Id: null, buId: null, unassigned: false,
  budget: 1000, actual: 0, committed: 0, remaining: 1000, amount: 1500, over: true, accountLabel: '6100 Opex', sliceLabel: 'FT Fibertime', ...o,
});
const noAccount = line({ glAccountId: '', grain: null, cc1Id: 'ht', budget: null, remaining: null, amount: 50, over: false, accountLabel: 'No account', sliceLabel: 'HT Hometech' });

function button() {
  const onApproved = vi.fn();
  const onError = vi.fn();
  render(<PurchaseOrderApproveButton poId={PO} onApproved={onApproved} onError={onError} onReload={async () => {}} />);
  return { onApproved, onError };
}

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); role.value = 'manager'; });

describe('PurchaseOrderApproveButton', () => {
  it('warn, over budget: the dialog (worded for an order) asks a reason, then approves the PO with it', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'warn', checks: true, lines: [line({}), noAccount], overCount: 1 })
      : json({ id: PO, status: 'approved' })));
    const { onApproved } = button();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(bodyOf(PREVIEW_URL)).toEqual({ purchaseOrderId: PO });
    expect(within(dialog).getByText(/each slice this order commits to/)).toBeTruthy();
    expect(within(dialog).getAllByText('This order').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText(/No account/).length).toBeGreaterThan(0);
    const approveInDialog = within(dialog).getByRole('button', { name: 'Approve' });
    expect((approveInDialog as HTMLButtonElement).disabled).toBe(true); // no reason yet
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Annual licence' } });
    fireEvent.click(approveInDialog);
    await waitFor(() => expect(bodyOf(APPROVE_URL)).toEqual({ budgetReason: 'Annual licence' }));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
  });

  it('no line meets a budget: approves at once, without a body', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'block', checks: true, lines: [noAccount], overCount: 0 })
      : json({ id: PO, status: 'approved' })));
    const { onApproved } = button();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodyOf(APPROVE_URL)).toEqual({}));
    await waitFor(() => expect(onApproved).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('block: an owner ticks Override and gives a reason; the override goes with the approval', async () => {
    role.value = 'owner';
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'block', checks: true, lines: [line({})], overCount: 1 })
      : json({ id: PO, status: 'approved' })));
    button();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Override the budget for this order/ }));
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Board approved' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Override and approve' }));
    await waitFor(() => expect(bodyOf(APPROVE_URL)).toEqual({ budgetReason: 'Board approved', budgetOverride: true }));
  });

  it('block, a manager: no override offered; a 409 the server answers stays in the dialog with its words', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'warn', checks: true, lines: [line({ over: false, amount: 10 })], overCount: 0 })
      : json({ success: false, error: { message: 'Over budget — approval refused: 6100 Opex', details: { code: 'BUDGET_EXCEEDED' } } }, 409)));
    button();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByText(/Over budget — approval refused: 6100 Opex/)).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox')).toBeNull(); // a manager may not override
  });
});
