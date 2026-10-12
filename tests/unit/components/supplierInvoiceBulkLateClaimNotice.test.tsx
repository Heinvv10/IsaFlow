// A bulk approve / Post to GL that claimed some bills' input VAT late (s16(3))
// must say so in its summary: the results carry `lateClaim`.
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...await orig<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { BulkActionBar } from '@/components/accounting/supplier-invoices/BulkActionBar';

const lc = (inputTax: number) => ({ claimDate: '2026-07-01', lockPeriod: { start: '2026-05-01', end: '2026-06-30' }, inputTax });

afterEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.info).mockReset(); vi.unstubAllGlobals(); });

describe('BulkActionBar — late claims', () => {
  it('summarises the bills whose VAT was claimed late', async () => {
    vi.stubGlobal('confirm', () => true);
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      action: 'approve', total: 3, succeeded: 3, failed: 0,
      results: [{ invoiceId: 'b1', ok: true, lateClaim: lc(150) }, { invoiceId: 'b2', ok: true, lateClaim: lc(30) }, { invoiceId: 'b3', ok: true }],
    } }), { status: 200 }));
    render(<BulkActionBar selected={new Set(['b1', 'b2', 'b3'])} busy={null} onBusyChange={() => {}}
      onError={() => {}} onComplete={async () => {}} onClear={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(notify.info).toHaveBeenCalledWith(
      "2 documents' input VAT of R180.00 claimed late, in the VAT period from 2026-07-01", 'Their VAT periods are filed.'));
  });
});
