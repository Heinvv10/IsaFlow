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

describe('the number reaches the label when the page keeps moving (z30 regression)', () => {
  /** The REAL preview answer shape the route returns (every field the service sends). */
  const REAL = {
    bankAccountId: 'b1', minConfidence: 0.8,
    lines: [1, 2, 3].map((n) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, date: '2026-11-17', description: `GP-BULK zq ${n}`, amount: -110 * n, glAccountId: 'g', glAccountCode: '6100', glAccountName: 'Fuel',
      vatCode: 'none', confidence: 0.95, strategy: 'rule', version: '2026-11-17T08:00:00.000000', effectiveVatCode: 'none', netAmount: 110 * n, vatAmount: 0, cc1Id: null, cc2Id: null, buId: null, cc1Code: null, cc2Code: null, buCode: null })),
    totalIn: 0, totalOut: 660, byAccount: [{ glAccountId: 'g', code: '6100', name: 'Fuel', count: 3, totalIn: 0, totalOut: 660 }],
    truncated: false, totalEligibleAtLeast: 3, scanTruncated: false, nextScanAfter: null, needsAttention: [], needsAttentionCount: 0,
    excluded: { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 }, previewToken: 'tok',
  };

  it('a refreshKey that moves while the first read is in flight does not drop its answer', async () => {
    let resolveRead!: (r: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((r) => { resolveRead = r; }));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={0} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={14} />); // the list finished loading
    resolveRead(ok(REAL));
    expect(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledTimes(1); // the change waits out the gap: a trailing read later, not now
  });

  it('shows the number from the real answer shape', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(REAL));
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={14} />);
    expect(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy();
  });

  it('an answer for the account the user has left is not applied to the new one', async () => {
    let first!: (r: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((r) => { first = r; })).mockResolvedValueOnce(ok({ ...REAL, lines: REAL.lines.slice(0, 1), bankAccountId: 'b2' }));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept 1 high-confidence suggestion' })).toBeTruthy();
    first(ok(REAL)); // the slow answer for b1 arrives late
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('button', { name: 'Accept 1 high-confidence suggestion' })).toBeTruthy();
  });

  it('a change that arrives during a read gets one trailing read after the gap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolveRead!: (r: Response) => void;
      vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((r) => { resolveRead = r; })).mockResolvedValue(ok({ ...REAL, lines: REAL.lines.slice(0, 2) }));
      const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={0} />);
      await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
      rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={1} />);
      resolveRead(ok(REAL));
      await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      expect(await screen.findByRole('button', { name: 'Accept 2 high-confidence suggestions' })).toBeTruthy();
      expect(apiFetch).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('the count survives a tab switch (L1)', () => {
  it('back on the New tab within the minute the number is there at once, with no new read', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok(preview(3)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy(); // synchronously, no "Accept high-confidence" flash
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('each account keeps its own count', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(3))).mockResolvedValueOnce(ok(preview(1)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 1 high-confidence suggestion' });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy();
  });

  it('a read still in flight when the tab is left lands, and shows on return', async () => {
    let resolveRead!: (r: Response) => void;
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise<Response>((r) => { resolveRead = r; }));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    resolveRead(ok(preview(2)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept 2 high-confidence suggestions' })).toBeTruthy();
  });
});

describe('an open dialog is not unmounted or retargeted by the page (z30 hypothesis)', () => {
  it('the New tab going inactive, or the account changing, under an open dialog leaves it open on its own account', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? ok({ runId: 'r', posted: [], refused: [], totalPosted: 0 }) : ok(preview(2))));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 2 high-confidence/ }));
    await screen.findByRole('dialog');
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    const post = await waitFor(() => {
      const c = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'POST');
      if (!c) throw new Error('no POST yet');
      return c;
    });
    expect(JSON.parse(String(post[1]!.body)).action).toBe('confirm');
    const previewCalls = vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('bankAccountId=')).map(([u]) => String(u));
    expect(previewCalls.filter((u) => u.includes('bankAccountId=b1')).length).toBeGreaterThanOrEqual(2); // the dialog's own preview is b1's
  });

  it('a dialog whose trigger has gone (count reached 0) stays until closed', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))).mockResolvedValueOnce(ok(preview(1)))
      .mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }], refused: [], totalPosted: 1 })).mockResolvedValue(ok(preview(0)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 1 high-confidence/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 1/ }));
    await screen.findByTestId('bulk-result');
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} refreshKey={5} />);
    expect(screen.getByTestId('bulk-result')).toBeTruthy();
  });
});
