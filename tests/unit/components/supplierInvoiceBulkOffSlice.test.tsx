/**
 * Budgets P5-2b: the bulk approve bar counts and words bills with a line outside every budgeted slice. The preview's
 * `overBills` counts them with the over-budget bills, so the modal says "over budget or not in a budgeted slice";
 * after a warn-mode batch the toast says which kinds it approved ("Not in a budgeted slice:" warnings).
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
const OFF = 'Not in a budgeted slice: 6100 Opex · no cost centre 1 · 2026-06: not in a budgeted slice';
const OVER = 'Over budget: 6100 Opex · FT Fibertime · 2026-06: over budget';

const bar = () => render(<BulkActionBar selected={new Set(['b1', 'b2', 'b3'])} busy={null} onBusyChange={vi.fn()}
  onError={() => {}} onComplete={async () => {}} onClear={() => {}} />);

/** A warn batch whose preview flags `overBills` and whose results carry these warnings. */
async function runWarnBatch(warnings: Array<string[] | undefined>) {
  vi.mocked(apiFetch).mockImplementation(async (url) => (url === PREVIEW_URL
    ? json({ policy: 'warn', overBills: 2, bills: [] })
    : json({ action: 'approve', total: 3, succeeded: 3, failed: 0, results: warnings.map((w, i) => (
      { invoiceId: `b${i + 1}`, invoiceNumber: `SI-${i + 1}`, ok: true, ...(w ? { budgetWarnings: w } : {}) })) })));
  bar();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/2 of 3 selected bills are over budget or not in a budgeted slice\. They will be approved and reported\./)).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
}

afterEach(() => { cleanup(); vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); });

describe('BulkActionBar — off-slice bills', () => {
  it('block: the modal counts them as refused', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => json({ policy: 'block', overBills: 1, bills: [] }));
    bar();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(/1 of 3 selected bills are over budget or not in a budgeted slice\. They will be refused/)).toBeTruthy();
  });

  it('warn, only off-slice warnings: "approved outside a budgeted slice"', async () => {
    await runWarnBatch([[OFF], [OFF], undefined]);
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('2 bills approved outside a budgeted slice', 'SI-1, SI-2'));
  });

  it('warn, both kinds: "approved over budget or outside a budgeted slice"', async () => {
    await runWarnBatch([[OVER], [OFF], undefined]);
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('2 bills approved over budget or outside a budgeted slice', 'SI-1, SI-2'));
  });
});
