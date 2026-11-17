/** WP6 UI: the bulk-accept modal - preview (rows, totals, by account, what was left out), confirm result, undo batch. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
import { apiFetch } from '@/lib/apiFetch';
import { BulkAcceptModal } from '@/components/accounting/bank-transactions/bulkAccept/BulkAcceptModal';
import { CONFIRM_RETRY } from '@/components/accounting/bank-transactions/bulkAccept/bulkAcceptApi';

useApiJsonOverMock();

const line = (n: number, amount: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, date: '2026-09-01', description: `LINE ${n}`, amount, glAccountId: 'gl-1', glAccountCode: '6100',
  glAccountName: 'Fuel', vatCode: null, confidence: 0.97, strategy: 'history', version: 'v', effectiveVatCode: 'none', netAmount: Math.abs(amount), vatAmount: 0,
  cc1Id: null, cc2Id: null, buId: null, cc1Code: null, cc2Code: null, buCode: null,
});
const PREVIEW = {
  bankAccountId: 'b1', minConfidence: 0.8, lines: [line(1, -100), line(2, 250)], totalIn: 250, totalOut: 100,
  byAccount: [{ glAccountId: 'gl-1', code: '6100', name: 'Fuel', count: 2, totalIn: 250, totalOut: 100 }],
  truncated: false, totalEligibleAtLeast: 2, scanTruncated: false, nextScanAfter: null, needsAttention: [], needsAttentionCount: 0,
  excluded: { badTarget: 0, reconciliationHeld: 0, periodClosed: 0, noPeriod: 0, vatLocked: 0, vatCode: 0 }, previewToken: 'tok',
};
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad = (message: string, status = 400) => new Response(JSON.stringify({ success: false, error: { message } }), { status });
const bodies = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));

beforeEach(() => { vi.mocked(apiFetch).mockReset(); CONFIRM_RETRY.timeoutMs = 60_000; CONFIRM_RETRY.backoffMs = [0, 0]; });
afterEach(cleanup);

function open(onChanged = vi.fn(), onClose = vi.fn()) {
  render(<BulkAcceptModal open bankAccountId="b1" onClose={onClose} onChanged={onChanged} />);
  return { onChanged, onClose };
}

describe('preview', () => {
  it('lists the rows with totals in and out and the by-account breakdown', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
    open();
    expect(await screen.findByText('LINE 1')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /Accept 2 high-confidence suggestions/ })).toBeTruthy();
    expect(screen.getByTestId('bulk-totals').textContent).toMatch(/Total in.*250/);
    expect(screen.getByTestId('bulk-totals').textContent).toMatch(/Total out.*100/);
    expect(within(screen.getByRole('list', { name: 'By account' })).getByText(/6100 Fuel: 2 lines/)).toBeTruthy();
  });

  it('says what was left out, and that more exist when cut at a page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, truncated: true, excluded: { ...PREVIEW.excluded, periodClosed: 3 }, needsAttentionCount: 4 }));
    open();
    expect(await screen.findByText(/3 in a closed period/)).toBeTruthy();
    expect(screen.getByText(/Showing the first 2/)).toBeTruthy();
    expect(screen.getByText(/4 held for a colleague or an approval/)).toBeTruthy();
  });

  it('pages past a scan that stopped early with the cursor', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, lines: [], previewToken: null, scanTruncated: true, nextScanAfter: 'cursor-1' }));
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Look further for more' }));
    await screen.findByText('LINE 1');
    expect(String(vi.mocked(apiFetch).mock.calls[1]![0])).toContain('scanAfter=cursor-1');
  });

  it('an empty preview has nothing to confirm', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, lines: [], previewToken: null }));
    open();
    await screen.findByText(/No high-confidence suggestions can be posted/);
    expect((screen.getByRole('button', { name: /Confirm and post 0/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed load is shown, not a blank dialog', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(bad('boom', 500));
    open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/boom|Could not load/);
  });
});

describe('confirm and undo', () => {
  const CONFIRMED = { runId: 'run-1', posted: [{ txId: PREVIEW.lines[0]!.id, journalEntryId: 'j1' }], refused: [{ txId: PREVIEW.lines[1]!.id, reason: 'the period is closed' }], totalPosted: 100 };

  async function confirmed() {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(CONFIRMED));
    const handlers = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    return handlers;
  }

  it('posts the previewed token and reports posted versus refused with the reason and the line', async () => {
    await confirmed();
    expect(bodies()[1]).toEqual({ action: 'confirm', previewToken: 'tok' });
    expect(screen.getByTestId('bulk-result').textContent).toMatch(/Posted 1 line.*1 not posted/);
    const refused = screen.getByRole('list', { name: 'Lines not posted' });
    expect(refused.textContent).toMatch(/LINE 2.*the period is closed/);
  });

  it('a double click on Confirm sends one request', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(CONFIRMED));
    open();
    const btn = await screen.findByRole('button', { name: /Confirm and post 2/ });
    fireEvent.click(btn); fireEvent.click(btn);
    await screen.findByTestId('bulk-result');
    expect(bodies().filter((b) => b?.action === 'confirm')).toHaveLength(1);
  });

  it('Undo batch sends exactly that run and says how many lines were reversed; it is offered once', async () => {
    await confirmed();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo batch' }));
    await screen.findByText(/Batch undone: 1 line reversed/);
    expect(bodies()[2]).toEqual({ action: 'undo', runId: 'run-1' });
    expect(screen.queryByRole('button', { name: 'Undo batch' })).toBeNull();
  });

  it('a partial undo names what was not undone', async () => {
    await confirmed();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ reversed: 0, skipped: 1, skippedBy: { reconciled: 1, contended: 0, failed: 0, offsetByHand: 0, creditCeiling: 0 }, undone: false, handOffsets: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo batch' }));
    await waitFor(() => expect(screen.getByText(/Not undone: 1 on a reconciliation/)).toBeTruthy());
  });

  it('a failed undo is shown and the button stays', async () => {
    await confirmed();
    vi.mocked(apiFetch).mockResolvedValueOnce(bad('That batch is already undone.'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo batch' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already undone/);
    expect(screen.getByRole('button', { name: 'Undo batch' })).toBeTruthy();
  });

  it('a failed confirm keeps the preview, shows the error, and the page still reloads on close', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(bad('Another bulk accept is running', 409));
    const { onChanged, onClose } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Another bulk accept/);
    expect(screen.getByText('LINE 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('closing after a post reloads the page; closing after a bare preview does not', async () => {
    const { onChanged } = await confirmed();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
    cleanup();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
    const b = open();
    await screen.findByText('LINE 1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(b.onChanged).not.toHaveBeenCalled();
  });
});

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const dialog = () => screen.getByRole('dialog');

describe('closing and focus (M1, M2)', () => {
  it('Escape and Cancel close a preview, and Cancel holds the focus from the start (not a disabled Confirm)', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
    const { onClose } = open();
    await screen.findByText('LINE 1');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(dialog().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('focus is inside the dialog while the preview is still loading', async () => {
    vi.mocked(apiFetch).mockReturnValueOnce(new Promise(() => undefined));
    open();
    await screen.findByText('Loading suggestions…');
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('Tab from the last control wraps to the first, so it never leaves the dialog', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
    open();
    await screen.findByText('LINE 1');
    const confirmBtn = screen.getByRole('button', { name: /Confirm and post 2/ });
    confirmBtn.focus();
    fireEvent.keyDown(confirmBtn, { key: 'Tab' });
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(confirmBtn);
  });

  it('while a confirm is in flight, Escape, Cancel and the close button do nothing; the result then reloads the page on Done', async () => {
    const gate = deferred<Response>();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockReturnValueOnce(gate.promise);
    const { onClose, onChanged } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByRole('button', { name: 'Posting…' });
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    gate.resolve(ok({ runId: 'run-1', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('an undo in flight cannot be closed over either', async () => {
    const gate = deferred<Response>();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok({ runId: 'run-1', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 }))
      .mockReturnValueOnce(gate.promise);
    const { onClose } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo batch' }));
    await screen.findByRole('button', { name: 'Undoing…' });
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    await screen.findByText(/Batch undone/);
  });
});

describe('a partial undo (M3)', () => {
  const RUN = { runId: 'run-1', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 };
  const OFFSET = { transactionId: 'a', lineDate: '2026-09-01', lineAmount: -100, lineDescription: 'LINE 1', journalEntryId: 'je', entryNumber: 'JE-2026-00042', entryDate: '2026-09-02', amount: 100, description: 'Hand fix', netsPostingOut: true, reclass: false, projection: [] };

  it('keeps Undo available so the message is true, lists the hand-offset lines, and closes the loop when a second undo finishes', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(RUN))
      .mockResolvedValueOnce(ok({ reversed: 0, skipped: 1, skippedBy: { reconciled: 0, contended: 0, failed: 0, offsetByHand: 1, creditCeiling: 0 }, undone: false, handOffsets: [OFFSET] }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo batch' }));
    await screen.findByText(/Not undone: 1 may already be corrected/);
    expect(within(screen.getByRole('list', { name: /later journal may already correct/ })).getByText(/JE-2026-00042/)).toBeTruthy();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Undo the rest of the batch' }));
    await screen.findByText(/Batch undone: 1 line reversed/);
    expect(bodies().filter((b) => b?.action === 'undo')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });
});

describe('paging, held lines, a dead token, nothing posted', () => {
  it('Show the next 25 keeps the page on screen (and confirmable) while the next loads, then replaces it', async () => {
    const gate = deferred<Response>();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, truncated: true, nextScanAfter: 'cur-2' })).mockReturnValueOnce(gate.promise);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Show the next 25' }));
    expect(screen.getByText('LINE 1')).toBeTruthy(); // still there while the next page loads
    expect((screen.getByRole('button', { name: 'Show the next 25' }) as HTMLButtonElement).disabled).toBe(true);
    gate.resolve(ok({ ...PREVIEW, lines: [line(3, -5)], totalIn: 0, totalOut: 5, previewToken: 'tok2' }));
    await screen.findByText('LINE 3');
    expect(screen.queryByText('LINE 1')).toBeNull();
    expect(String(vi.mocked(apiFetch).mock.calls[1]![0])).toContain('scanAfter=cur-2');
  });

  it('a failed next page leaves the current page and its Confirm', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, truncated: true, nextScanAfter: 'cur-2' })).mockResolvedValueOnce(bad('busy', 500));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Show the next 25' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/busy|Could not load/);
    expect(screen.getByText('LINE 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Confirm and post 2/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('after a confirm, a cut list offers the next batch, read from the start', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, truncated: true, nextScanAfter: 'cur-2' }))
      .mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 }))
      .mockResolvedValueOnce(ok(PREVIEW));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview the next batch' }));
    await screen.findByText('LINE 1');
    expect(String(vi.mocked(apiFetch).mock.calls[2]![0])).not.toContain('scanAfter');
  });

  it('lists the held lines, up to the 50 the server sends', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, needsAttentionCount: 60, needsAttention: [
      { id: 'abcdef12-0000-4000-8000-000000000001', kind: 'importer', reason: 'you imported it' },
      { id: 'fedcba98-0000-4000-8000-000000000002', kind: 'approval', reason: 'over the limit' }] }));
    open();
    const list = await screen.findByRole('list', { name: 'Held lines', hidden: true });
    expect(list.textContent).toMatch(/abcdef12.*you imported it/);
    expect(list.textContent).toMatch(/fedcba98.*needs an approval.*over the limit/);
    expect(screen.getByText(/60 held for a colleague/)).toBeTruthy();
  });

  it('a failed confirm kills the token: Confirm is disabled until Refresh preview brings a fresh one', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(bad('The previewed line changed', 400)).mockResolvedValueOnce(ok({ ...PREVIEW, previewToken: 'fresh' }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: /Confirm and post 2/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh preview' }));
    await waitFor(() => expect((screen.getByRole('button', { name: /Confirm and post 2/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a confirm that posted nothing (no run) says so, offers no undo, and does not reload the page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok({ runId: null, posted: [], refused: [{ txId: PREVIEW.lines[0]!.id, reason: 'busy - retry' }], totalPosted: 0 }));
    const { onChanged } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    expect((await screen.findByTestId('bulk-result')).textContent).toMatch(/Posted 0 lines.*1 not posted/);
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('a lost answer, a double click, a stale answer', () => {

  const RUNNING = () => new Response(JSON.stringify({ success: false, message: 'This request is still being processed. Wait a moment and check before sending it again.' }), { status: 409 });
  const keysOf = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === 'confirm')
    .map(([, init]) => (init?.headers as Record<string, string>)['Idempotency-Key']);
  const CONFIRMED_RUN = { runId: 'run-9', posted: [{ txId: PREVIEW.lines[0]!.id, journalEntryId: 'j' }], refused: [], totalPosted: 100 };

  it('a dropped answer is resent with the SAME key and replays the first answer: the runId, and Undo uses it', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok(CONFIRMED_RUN))
      .mockResolvedValueOnce(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    const { onChanged } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    const keys = keysOf();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo batch' }));
    await screen.findByText(/Batch undone: 1 line reversed/);
    expect(bodies().at(-1)).toEqual({ action: 'undo', runId: 'run-9' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onChanged).toHaveBeenCalled();
  });

  it.each([502, 503, 504, 408])('a %i is ambiguous (a gateway, not the route): resent, not given up on', async (status) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(bad('Bad Gateway', status)).mockResolvedValueOnce(ok(CONFIRMED_RUN));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    expect(keysOf()).toHaveLength(2);
  });

  it('"still being processed" (the first send has not finished) is resent too', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(RUNNING()).mockResolvedValueOnce(ok(CONFIRMED_RUN));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    expect(keysOf()).toHaveLength(2);
  });

  it.each([400, 409, 422, 429])('a %i refusal is definitive: no resend, the token is dead', async (status) => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(bad('Another bulk accept is running for this bank account.', status));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByRole('alert');
    expect(keysOf()).toHaveLength(1);
    expect((screen.getByRole('button', { name: /Confirm and post 2/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('two batches in a minute: each confirm has its own key; the second\'s resend replays batch 2, and Undo targets batch 2', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok({ ...PREVIEW, truncated: true })).mockResolvedValueOnce(ok({ ...CONFIRMED_RUN, runId: 'batch-1' }))
      .mockResolvedValueOnce(ok({ ...PREVIEW, previewToken: 'tok-2' })).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok({ ...CONFIRMED_RUN, runId: 'batch-2' }))
      .mockResolvedValueOnce(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    fireEvent.click(screen.getByRole('button', { name: 'Preview the next batch' }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await waitFor(() => expect(keysOf()).toHaveLength(3));
    await screen.findByText(/Posted 1 line/);
    const [k1, k2, k2again] = keysOf();
    expect(k2).not.toBe(k1);
    expect(k2again).toBe(k2);
    fireEvent.click(screen.getByRole('button', { name: 'Undo batch' }));
    await screen.findByText(/Batch undone/);
    expect(bodies().at(-1)).toEqual({ action: 'undo', runId: 'batch-2' });
  });

  it('every retry fails: the modal says the batch may have posted, Confirm is dead, closing is allowed and reloads the page', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockRejectedValue(new TypeError('Failed to fetch'));
    const { onClose, onChanged } = open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/may have posted.*Auto-post runs panel/);
    expect(keysOf()).toHaveLength(3);
    expect(new Set(keysOf()).size).toBe(1);
    expect((screen.getByRole('button', { name: /Confirm and post 2/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('a confirm that never answers is cut off at the client timeout and then resent', async () => {
    CONFIRM_RETRY.timeoutMs = 20;
    const hang = (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockImplementationOnce(hang as never).mockResolvedValueOnce(ok(CONFIRMED_RUN));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    expect(keysOf()).toHaveLength(2);
  });

  it('two clicks batched into one update send one confirm', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValue(ok({ runId: 'r', posted: [], refused: [], totalPosted: 0 }));
    open();
    const btn = await screen.findByRole('button', { name: /Confirm and post 2/ });
    act(() => { fireEvent.click(btn); fireEvent.click(btn); });
    await screen.findByTestId('bulk-result');
    expect(bodies().filter((b) => b?.action === 'confirm')).toHaveLength(1);
  });

  it('two Undo clicks batched into one update send one undo', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok({ runId: 'r', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 }))
      .mockResolvedValue(ok({ reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] }));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    const undoBtn = await screen.findByRole('button', { name: 'Undo batch' });
    act(() => { fireEvent.click(undoBtn); fireEvent.click(undoBtn); });
    await screen.findByText(/Batch undone/);
    expect(bodies().filter((b) => b?.action === 'undo')).toHaveLength(1);
  });

  it('an answer to a confirm that a newer load has overtaken is dropped', async () => {
    const gate = deferred<Response>();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockReturnValueOnce(gate.promise).mockResolvedValueOnce(ok({ ...PREVIEW, lines: [line(4, -9)], previewToken: 'other' }));
    const view = render(<BulkAcceptModal open bankAccountId="b1" onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    view.rerender(<BulkAcceptModal open bankAccountId="b2" onClose={vi.fn()} onChanged={vi.fn()} />); // another account: a new load
    await screen.findByText('LINE 4');
    gate.resolve(ok({ runId: 'late', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.queryByTestId('bulk-result')).toBeNull();
    expect(screen.getByText('LINE 4')).toBeTruthy();
  });
});

describe('round 4: plain http, a dropped undo, a cut-short body, the retry notice', () => {
  const RUN1 = { runId: 'run-9', posted: [{ txId: 'a', journalEntryId: 'j' }], refused: [], totalPosted: 1 };
  const UNDONE = { reversed: 1, skipped: 0, skippedBy: {}, undone: true, handOffsets: [] };
  const keyOf = (n: number) => (vi.mocked(apiFetch).mock.calls[n]![1]?.headers as Record<string, string>)['Idempotency-Key'];

  it('Confirm works where crypto.randomUUID does not exist (plain http): a v4 key is still sent', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID') ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID');
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }); // no randomUUID
    try {
      vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(RUN1));
      open();
      fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
      await screen.findByTestId('bulk-result');
      expect(keyOf(1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally { vi.unstubAllGlobals(); void real; vi.stubGlobal('fetch', (u: unknown, i?: unknown) => vi.mocked(apiFetch)(u as never, i as never)); }
  });

  it('a key that cannot be made fails into the error state, not a stuck Confirm', async () => {
    vi.stubGlobal('crypto', undefined);
    vi.stubGlobal('Math', Object.assign(Object.create(Math), { random: () => { throw new Error('no entropy'); } }));
    try {
      vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW));
      open();
      fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
      expect((await screen.findByRole('alert')).textContent).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
    } finally { vi.unstubAllGlobals(); vi.stubGlobal('fetch', (u: unknown, i?: unknown) => vi.mocked(apiFetch)(u as never, i as never)); }
  });

  it('a dropped Undo answer is resent with the same key and ends as "Batch undone", not "already undone"', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(RUN1))
      .mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(ok(UNDONE));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo batch' }));
    await screen.findByText(/Batch undone: 1 line reversed/);
    expect(keyOf(3)).toBe(keyOf(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  });

  it('an unresolved Undo says it may have gone through, and keeps the button', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(ok(RUN1)).mockRejectedValue(new TypeError('Failed to fetch'));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo batch' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/may have gone through.*Auto-post runs panel/);
    expect(screen.getByRole('button', { name: 'Undo batch' })).toBeTruthy();
  });

  it('a 200 whose body is cut short is ambiguous: resent with the same key, not a dead token', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockResolvedValueOnce(new Response('{"success":tr', { status: 200 })).mockResolvedValueOnce(ok(RUN1));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByTestId('bulk-result');
    expect(keyOf(2)).toBe(keyOf(1));
  });

  it('shows "Still trying" during a resend, and not once it is answered', async () => {
    CONFIRM_RETRY.backoffMs = [80, 80];
    const gate = deferred<Response>();
    vi.mocked(apiFetch).mockResolvedValueOnce(ok(PREVIEW)).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockReturnValueOnce(gate.promise);
    open();
    fireEvent.click(await screen.findByRole('button', { name: /Confirm and post 2/ }));
    await screen.findByText(/Still trying/);
    gate.resolve(ok(RUN1));
    await screen.findByTestId('bulk-result');
    expect(screen.queryByText(/Still trying/)).toBeNull();
  });
});
