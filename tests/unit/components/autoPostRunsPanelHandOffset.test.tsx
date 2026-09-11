/**
 * R-079 — the auto-post Undo refuses a line a later journal may already
 * correct. The panel describes the line and the journal (so two refused lines
 * sharing one journal can be told apart) and offers the two recorded decisions
 * — "Mark as corrected by hand" and "Not the correction — undo anyway" — each
 * behind its own confirm dialog, never one click.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const RUN = { id: 'run-1', source: 'import', postedCount: 1, totalAmount: 100, createdAt: '2026-09-10', undoneAt: null };
const OFFSET = {
  transactionId: 'tx-1', lineDate: '2026-05-15', lineAmount: -100, lineDescription: 'Office rent',
  journalEntryId: 'je-hand', entryNumber: 'JE-2026-00042', entryDate: '2026-05-20', amount: 60,
  description: 'Reclass rent',
};
const refused = {
  success: true,
  data: {
    reversed: 0, skipped: 1, alreadyUndone: 0, undone: false,
    skippedBy: { reconciled: 0, contended: 0, failed: 0, offsetByHand: 1 },
    handOffsets: [OFFSET],
  },
};
const decided = (extra: Record<string, unknown>) => ({
  success: true,
  data: { transactionId: 'tx-1', offsetJournalId: 'je-hand', offsetEntryNumber: 'JE-2026-00042', runClosed: true, ...extra },
});

/** Each POST answers with the next reply in order; every body is recorded. */
function respond(...replies: Array<[number, unknown]>): Array<Record<string, unknown>> {
  const queue = [...replies];
  const posted: Array<Record<string, unknown>> = [];
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ data: { runs: [RUN] } }));
    posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    const [status, body] = queue.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
  return posted;
}

async function undoAndSeeRefusal(onUndone = vi.fn()): Promise<void> {
  render(<AutoPostRunsPanel onUndone={onUndone} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await screen.findByText(/may already correct this posting/);
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

it('describes the line and the journal, and counts the reason in the notice', async () => {
  respond([200, refused]);
  await undoAndSeeRefusal();

  const item = screen.getByText(/may already correct this posting/).textContent ?? '';
  expect(item).toMatch(/Line 2026-05-15 · −R100[.,]00 · Office rent/);
  expect(item).toMatch(/JE-2026-00042 \(\s*2026-05-20 · R60[.,]00 · Reclass rent\)/);
  expect(item).toMatch(/reverse that journal and undo again/);
  expect(screen.getByRole('status').textContent).toMatch(/1 may already be corrected by a later journal/);
});

it.each([
  ['Mark as corrected by hand', 'Mark JE-2026-00042 as the correction'],
  ['Not the correction — undo anyway', 'Undo the line anyway'],
])('"%s" asks first, and Cancel records nothing', async (button, accept) => {
  const posted = respond([200, refused]);
  await undoAndSeeRefusal();

  fireEvent.click(screen.getByRole('button', { name: button }));

  expect(await screen.findByRole('button', { name: accept })).toBeTruthy();
  expect(posted).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: accept })).toBeNull();
  expect(posted).toHaveLength(1);
});

it.each([
  ['Mark as corrected by hand', 'Mark JE-2026-00042 as the correction', 'confirmHandCorrection', {}],
  ['Not the correction — undo anyway', 'Undo the line anyway', 'undoAnyway', { outcome: 'reversed', handOffset: null }],
])('"%s" records that decision for exactly that line and journal, then clears it', async (button, accept, action, extra) => {
  const posted = respond([200, refused], [200, decided(extra)]);
  const onUndone = vi.fn();
  await undoAndSeeRefusal(onUndone);

  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.click(await screen.findByRole('button', { name: accept }));

  await vi.waitFor(() => expect(onUndone).toHaveBeenCalledTimes(2));
  expect(posted[1]).toEqual({ action, runId: 'run-1', transactionId: 'tx-1', offsetJournalId: 'je-hand' });
  expect(screen.queryByText(/may already correct this posting/)).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows the next blocking journal when undo-anyway finds another one', async () => {
  const next = { ...OFFSET, journalEntryId: 'je-2', entryNumber: 'JE-2026-00043' };
  respond([200, refused], [200, decided({ outcome: 'offsetByHand', handOffset: next, runClosed: false })]);
  await undoAndSeeRefusal();

  fireEvent.click(screen.getByRole('button', { name: 'Not the correction — undo anyway' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Undo the line anyway' }));

  expect(await screen.findByText(/JE-2026-00043 \(/)).toBeTruthy();
  expect(screen.queryByText(/JE-2026-00042 \(/)).toBeNull();
});

it("shows the server's refusal and keeps the line listed", async () => {
  respond(
    [200, refused],
    [400, { success: false, error: { code: 'BAD_REQUEST', message: 'That journal does not correct this posting' } }],
  );
  await undoAndSeeRefusal();

  fireEvent.click(screen.getByRole('button', { name: 'Mark as corrected by hand' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Mark JE-2026-00042 as the correction' }));

  expect(await screen.findByText('That journal does not correct this posting')).toBeTruthy();
  expect(screen.getByText(/may already correct this posting/)).toBeTruthy();
});
