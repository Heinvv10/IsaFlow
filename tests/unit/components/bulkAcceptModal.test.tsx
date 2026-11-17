/** WP6 UI: the bulk-accept modal - preview (rows, totals, by account, what was left out), confirm result, undo batch. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
import { apiFetch } from '@/lib/apiFetch';
import { BulkAcceptModal } from '@/components/accounting/bank-transactions/bulkAccept/BulkAcceptModal';

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

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
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
    expect(screen.getByText(/4 need a colleague or an approval/)).toBeTruthy();
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
