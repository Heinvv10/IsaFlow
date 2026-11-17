/** WP6 UI: the "Accept N high-confidence suggestions" button - its count, when it hides, and the reload after a batch. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
import { apiFetch } from '@/lib/apiFetch';
import { BulkAcceptButton } from '@/components/accounting/bank-transactions/bulkAccept/BulkAcceptButton';

useApiJsonOverMock();
const preview = (n: number, more = false) => ({
  lines: Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, date: '2026-09-01', description: `L${i}`, amount: -1, glAccountId: 'g', glAccountCode: '6100', glAccountName: 'Fuel', confidence: 0.9, effectiveVatCode: 'none' })),
  totalIn: 0, totalOut: n, byAccount: [], truncated: more, scanTruncated: false, nextScanAfter: null, needsAttention: [], needsAttentionCount: 0,
  excluded: { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 }, previewToken: n ? 'tok' : null,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

describe('BulkAcceptButton', () => {
  it('names how many suggestions can be accepted, with a plus when more exist than one batch', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(25, true)));
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept 25+ high-confidence suggestions' })).toBeTruthy();
  });

  it('is singular for one', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1)));
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept 1 high-confidence suggestion' })).toBeTruthy();
  });

  it('is absent with nothing to accept, and off the New tab (no request is made there)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(0)));
    const { container, rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('button')).toBeNull());
    vi.mocked(apiFetch).mockReset();
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    expect(container.querySelector('button')).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('still offers the action when the count could not be read (the dialog reports the failure)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept high-confidence suggestions' })).toBeTruthy();
  });

  it('opens the dialog, and reloads the page once a batch was posted', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))); // count
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))); // the dialog's preview
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }], refused: [], totalPosted: 1 }));
    const onChanged = vi.fn();
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 1 high-confidence/ }));
    await screen.findByRole('dialog');
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 1/ }));
    await screen.findByTestId('bulk-result');
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(0)));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
