/** WP6 UI: the "Accept N high-confidence suggestions" button - its count, when it hides, and the reload after a batch. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('the count is throttled (M4)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reads once, not again for a refresh within the minute, then once more when the minute has passed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(3)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={10} />);
    await screen.findByRole('button', { name: /Accept 3 high-confidence/ });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={9} />); // a single accept moved the total
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={8} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(apiFetch).toHaveBeenCalledTimes(2); // one trailing read for the two changes
  });

  it('a tab switch away and back does not read again inside the minute', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(3)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: /Accept 3/ });
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('focus (M2)', () => {
  it('returns to the button when the dialog closes', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(2)));
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    const button = await screen.findByRole('button', { name: /Accept 2 high-confidence/ });
    fireEvent.click(button);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('goes to the grid when nothing is left to accept and the button has gone', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))); // count
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))); // dialog preview
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }], refused: [], totalPosted: 1 }));
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(0))); // the re-read after the batch
    render(<><div role="group" aria-label="Bank transactions grid" tabIndex={0} data-testid="grid" /><BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 1 high-confidence/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 1/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('grid')));
  });
});
