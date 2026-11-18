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

describe('the dialog keeps ONE tree position (review: a flip under it remounted it)', () => {
  const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
  const RESULT = { runId: 'run-1', posted: [{ txId: 'id-0', journalEntryId: 'j0' }, { txId: 'id-1', journalEntryId: 'j1' }], refused: [], totalPosted: 2 };
  const gets = (account: string) => vi.mocked(apiFetch).mock.calls.filter(([u, i]) => (i?.method ?? 'GET') === 'GET' && String(u).includes(`bankAccountId=${account}`)).length;

  it('the tab flipping while a confirm is in flight: the same dialog node, then the result and Undo', async () => {
    const post = deferred<Response>();
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? post.promise : ok(preview(2))));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 2 high-confidence/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByRole('button', { name: 'Posting…' });
    const before = screen.getByRole('dialog');
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBe(before);
    post.resolve(ok(RESULT));
    expect((await screen.findByTestId('bulk-result')).textContent).toMatch(/Posted 2 lines/);
    expect(screen.getByRole('button', { name: 'Undo batch' })).toBeTruthy();
    expect(screen.getByRole('dialog')).toBe(before);
  });

  it('the tab flipping on the result screen: Undo is still there', async () => {
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => (init?.method === 'POST' ? ok(RESULT) : ok(preview(2))));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 2 high-confidence/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    const before = screen.getByRole('dialog');
    rerender(<BulkAcceptButton bankAccountId="b1" active={false} onChanged={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBe(before);
    expect(screen.getByRole('button', { name: 'Undo batch' })).toBeTruthy();
    expect(screen.getByTestId('bulk-result').textContent).toMatch(/Posted 2 lines/);
  });

  it('the account flipping: the dialog stays on its own account and never previews the new one', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => ok(preview(String(u).includes('b2') ? 5 : 2)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Accept 2 high-confidence/ }));
    await screen.findByRole('button', { name: /Confirm and post 2/ });
    const before = screen.getByRole('dialog', { name: 'Accept 2 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await waitFor(() => expect(gets('b2')).toBe(1)); // the button's count of b2
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(gets('b2')).toBe(1); // and no preview of b2 by the dialog
    expect(screen.getByRole('dialog', { name: 'Accept 2 high-confidence suggestions' })).toBe(before);
  });
});

describe('the count is throttled per account (review: one shared "last read")', () => {
  const gets = (account: string) => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes(`bankAccountId=${account}`)).length;

  it('switching A, B, A within the minute reads A once', async () => {
    vi.mocked(apiFetch).mockImplementation(async (u) => ok(preview(String(u).includes('b2') ? 5 : 3)));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 5 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.getByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy();
    expect(gets('b1')).toBe(1);
    expect(gets('b2')).toBe(1);
  });

  it("an account's read in flight still lands after a switch away, so coming back shows its number with no new read", async () => {
    let resolveA!: (r: Response) => void;
    const a = new Promise<Response>((r) => { resolveA = r; });
    vi.mocked(apiFetch).mockImplementation(async (u) => (String(u).includes('b1') ? a : ok(preview(5))));
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(gets('b1')).toBe(1));
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 5 high-confidence suggestions' });
    resolveA(ok(preview(3)));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' })).toBeTruthy();
    expect(gets('b1')).toBe(1);
  });
});

describe('focus back on close has one path (review: the shell and the button both moved it)', () => {
  it('Done after a batch that empties the account: focus goes to the button, then the grid, and never to the table', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(preview(1))).mockResolvedValueOnce(ok(preview(1)))
      .mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }], refused: [], totalPosted: 1 })).mockResolvedValue(ok(preview(0)));
    render(<>
      <div data-testid="bank-tx-table" tabIndex={-1} />
      <div role="group" aria-label="Bank transactions grid" tabIndex={0} data-testid="grid" />
      <BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />
    </>);
    const table = screen.getByTestId('bank-tx-table');
    const tableFocused = vi.fn();
    table.addEventListener('focus', tableFocused);
    const trigger = await screen.findByRole('button', { name: /Accept 1 high-confidence/ });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 1/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(trigger); // the button is still there until the count is read again
    await waitFor(() => expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('grid')));
    expect(tableFocused).not.toHaveBeenCalled();
  });
});

describe('review round 2: the dialog\'s own account after a flip', () => {
  const postBody = () => {
    const c = vi.mocked(apiFetch).mock.calls.find(([, i]) => i?.method === 'POST');
    return c ? JSON.parse(String(c[1]!.body)) as { action: string; previewToken?: string } : null;
  };

  it("a batch confirmed after the page moved to b2 posts b1's token, and b1's count is read again (no stale \"Accept 3\")", async () => {
    let b1Gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if (init?.method === 'POST') return ok({ runId: 'r', posted: [0, 1, 2].map((i) => ({ txId: `id-${i}`, journalEntryId: `j${i}` })), refused: [], totalPosted: 3 });
      if (String(u).includes('b2')) return ok({ ...preview(5), previewToken: 'tok-b2' });
      b1Gets += 1;
      return ok({ ...preview(b1Gets <= 2 ? 3 : 0), previewToken: 'tok-b1' }); // the count, the dialog's preview, then after the batch
    });
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' }));
    const confirmBtn = await screen.findByRole('button', { name: /Confirm and post 3/ });
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 5 high-confidence suggestions' });
    fireEvent.click(confirmBtn);
    await screen.findByTestId('bulk-result');
    expect(postBody()).toEqual({ action: 'confirm', previewToken: 'tok-b1' });
    const b2Before = vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('b2')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); }); // the page stays on b2 a moment
    expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('b2')).length).toBe(b2Before); // b2 was not touched
    expect(b1Gets).toBe(2);
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(b1Gets).toBe(3)); // read again at once, whatever the gap
    await waitFor(() => expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull());
  });

  it('an older read of an account never overwrites a newer one (the per-account landing guard)', async () => {
    let resolveOld!: (r: Response) => void;
    const old = new Promise<Response>((r) => { resolveOld = r; });
    let b1Gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if (init?.method === 'POST') return ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }, { txId: 'id-1', journalEntryId: 'j1' }], refused: [], totalPosted: 2 });
      if (String(u).includes('b2')) return ok(preview(5));
      b1Gets += 1;
      return b1Gets === 1 ? old : ok(preview(b1Gets === 2 ? 2 : 0)); // 1: a slow count; 2: the dialog's preview; 3: after the batch
    });
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await waitFor(() => expect(b1Gets).toBe(1));
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 5 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept high-confidence suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(b1Gets).toBe(3));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull());
    resolveOld(ok(preview(3))); // the slow first read arrives last
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
  });

  it("a forced re-read of the dialog's account does not leak to the next account: switching right after Done reads b2 within its gap", async () => {
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if (init?.method === 'POST') return ok({ runId: 'r', posted: [{ txId: 'id-0', journalEntryId: 'j' }], refused: [], totalPosted: 1 });
      return ok(preview(String(u).includes('b2') ? 5 : 3));
    });
    const b2Gets = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('b2')).length;
    const { rerender } = render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />);
    await screen.findByRole('button', { name: 'Accept 5 high-confidence suggestions' });
    rerender(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    rerender(<BulkAcceptButton bankAccountId="b2" active onChanged={vi.fn()} />); // before b1's forced read has started
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(b2Gets()).toBe(1);
  });
});

describe('review round 3: what invalidate clears, and focus behind an open dialog', () => {
  const POSTED = { runId: 'r', posted: [0, 1, 2].map((i) => ({ txId: `id-${i}`, journalEntryId: `j${i}` })), refused: [], totalPosted: 3 };

  it('a count read still in flight when the batch posts never lands its old number', async () => {
    let resolveOld!: (r: Response) => void;
    const old = new Promise<Response>((r) => { resolveOld = r; });
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (init?.method === 'POST') return ok(POSTED);
      gets += 1;
      if (gets === 1) return old; // a slow count, read before the batch
      return gets === 2 ? ok(preview(3)) : new Promise<Response>(() => undefined); // 2: the dialog's preview; 3: the re-read hangs
    });
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept high-confidence suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    resolveOld(ok(preview(3))); // read before the batch, answered after it
    await waitFor(() => expect(gets).toBe(3)); // its trailing re-read has started: the old answer has been handled
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.queryByRole('button', { name: /Accept 3/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Accept high-confidence suggestions' })).toBeTruthy();
  });

  it('after Done the label does not show the old number while the new count is read', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async (_u, init) => {
      if (init?.method === 'POST') return ok(POSTED);
      gets += 1;
      return gets <= 2 ? ok(preview(3)) : new Promise<Response>(() => undefined); // the read after the batch hangs
    });
    render(<BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 3 high-confidence suggestions' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 3/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(gets).toBe(3));
    expect(screen.getByRole('button', { name: 'Accept high-confidence suggestions' })).toBeTruthy();
  });

  it('the count landing 0 while the dialog is open does not pull focus to the grid behind it', async () => {
    let resolveCount!: (r: Response) => void;
    const slow = new Promise<Response>((r) => { resolveCount = r; });
    let gets = 0;
    vi.mocked(apiFetch).mockImplementation(async () => { gets += 1; return gets === 1 ? slow : ok(preview(2)); });
    render(<><div role="group" aria-label="Bank transactions grid" tabIndex={0} data-testid="grid" /><BulkAcceptButton bankAccountId="b1" active onChanged={vi.fn()} /></>);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept high-confidence suggestions' }));
    await screen.findByRole('button', { name: /Confirm and post 2/ });
    (document.activeElement as HTMLElement | null)?.blur(); // focus on the body, e.g. after a click on plain text
    resolveCount(ok(preview(0)));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Accept .*high-confidence/ })).toBeNull());
    expect(document.activeElement).not.toBe(screen.getByTestId('grid'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

