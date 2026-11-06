/**
 * Budgets P5-2 (review R6/R7): the bulk approve bar previews the selection's budget first. Over-budget
 * bills open the modal (the count, one reason for the batch, sent with the action); the bar is busy while
 * the preview reads, so a second click starts no second preview; bills a warn-mode batch approved over
 * budget are named afterwards. A selection past the preview's cap goes straight to the confirm.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const PREVIEW_URL = '/api/accounting/budgets/remaining';
const ACTION_URL = '/api/accounting/supplier-invoices-bulk-action';
const bodyOf = (url: string) => {
  const call = vi.mocked(apiFetch).mock.calls.find(([u]) => u === url);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};

function bar(ids: string[], onBusyChange = vi.fn()) {
  render(<BulkActionBar selected={new Set(ids)} busy={null} onBusyChange={onBusyChange}
    onError={() => {}} onComplete={async () => {}} onClear={() => {}} />);
  return onBusyChange;
}

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); vi.unstubAllGlobals(); });

describe('BulkActionBar — budget', () => {
  it('over-budget bills open the modal; its one reason is sent with the action; approved-over-budget bills are named', async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'warn', overBills: 1, bills: [] })
      : json({ action: 'approve', total: 2, succeeded: 2, failed: 0, results: [
        { invoiceId: 'b1', invoiceNumber: 'SI-1', ok: true, budgetWarnings: ['Over budget: 6100 Opex · 2026-06: over budget'] },
        { invoiceId: 'b2', invoiceNumber: 'SI-2', ok: true }] })));
    const busy = bar(['b1', 'b2']);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/1 of 2 selected bills are over budget/)).toBeTruthy();
    expect(busy).toHaveBeenCalledWith('approve'); // busy while the preview read
    expect(confirm).not.toHaveBeenCalled(); // the modal is the confirmation
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Quarter-end batch' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
    await waitFor(() => expect(bodyOf(ACTION_URL)).toEqual({ action: 'approve', invoiceIds: ['b1', 'b2'], budgetReason: 'Quarter-end batch' }));
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('1 bill approved over budget', 'SI-1'));
  });

  it('block: the modal says the over-budget bills will be refused and asks no reason', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ policy: 'block', overBills: 2, bills: [] }));
    bar(['b1', 'b2', 'b3']);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/2 of 3 selected bills are over budget or not in a budgeted slice\. They will be refused/)).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('nothing over budget: the plain confirm, then the action without a reason', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
      ? json({ policy: 'warn', overBills: 0, bills: [] })
      : json({ action: 'approve', total: 1, succeeded: 1, failed: 0, results: [{ invoiceId: 'b1', ok: true }] })));
    bar(['b1']);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(bodyOf(ACTION_URL)).toEqual({ action: 'approve', invoiceIds: ['b1'] }));
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('more bills than the preview takes: no preview, the plain confirm', async () => {
    vi.stubGlobal('confirm', () => false);
    bar(Array.from({ length: 51 }, (_, i) => `b${i}`));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(apiFetch).not.toHaveBeenCalled());
  });
});
