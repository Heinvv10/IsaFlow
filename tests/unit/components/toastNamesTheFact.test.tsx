/**
 * The toast clips its second line to one row, so what the person must learn has
 * to be the TITLE (PR #688 round 5). Rendered through the real toast and read
 * back from the screen: the bulk supplier-invoice bar names the bills, and the
 * late-claim notice says what happened in its title. Not a spy on `notify`.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Toaster } from 'react-hot-toast';
import toast from 'react-hot-toast';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/apiFetch';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

const INACTIVE = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const lc = (inputTax: number) => ({ claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax });

async function approve(results: unknown[]) {
  vi.stubGlobal('confirm', () => true);
  vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
    action: 'approve', total: results.length, succeeded: results.length, failed: 0, results,
  } }), { status: 200 }));
  render(<><Toaster /><BulkActionBar selected={new Set(['b1', 'b2'])} busy={null} onBusyChange={() => {}}
    onError={() => {}} onComplete={async () => {}} onClear={() => {}} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
}

afterEach(() => { cleanup(); toast.remove(); vi.mocked(apiFetch).mockReset(); vi.unstubAllGlobals(); });

describe('bulk supplier-invoice toast', () => {
  it('names the bills whose cost centre was not applied', async () => {
    await approve([
      { invoiceId: 'b1', invoiceNumber: 'QAF4-12', ok: true, warnings: [INACTIVE] },
      { invoiceId: 'b2', invoiceNumber: 'QAF4-13', ok: true, warnings: [INACTIVE] },
    ]);
    expect(await screen.findByText('Posted — cost centre OLD not applied (inactive)')).toBeTruthy();
    expect(screen.getByText('+1 more, in QAF4-12, QAF4-13')).toBeTruthy();
  });

  it('says what happened to the VAT in the title, not in the clipped line', async () => {
    await approve([
      { invoiceId: 'b1', invoiceNumber: 'QAF4-12', ok: true, lateClaim: lc(150) },
      { invoiceId: 'b2', invoiceNumber: 'QAF4-13', ok: true },
    ]);
    expect(await screen.findByText('Input VAT of R150.00 claimed late, from 2026-07-01')).toBeTruthy();
    expect(screen.getByText('Period 2026-05-01 to 2026-06-30 is filed.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/was claimed late, in the VAT period/)).toBeNull());
  });
});
