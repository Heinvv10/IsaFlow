/**
 * R-079 — the auto-post Undo refuses a line a manual journal already offsets
 * and names that journal. The panel says so, with both remedies, and offers
 * the recorded override behind a confirm dialog — never one click.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const RUN = { id: 'run-1', source: 'import', postedCount: 1, totalAmount: 100, createdAt: '2026-09-10', undoneAt: null };
const OFFSET = { transactionId: 'tx-1', journalEntryId: 'je-hand', entryNumber: 'JE-2026-00042' };
const refused = {
  success: true,
  data: {
    reversed: 0, skipped: 1, alreadyUndone: 0, undone: false,
    skippedBy: { reconciled: 0, contended: 0, failed: 0, offsetByHand: 1 },
    handOffsets: [OFFSET],
  },
};

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
  await screen.findByText(/JE-2026-00042 already offsets this posting/);
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

it('names the journal and both remedies, and counts the reason in the notice', async () => {
  respond([200, refused]);
  await undoAndSeeRefusal();

  expect(screen.getByText(/JE-2026-00042 already offsets this posting — reverse that journal instead, or confirm it is\s+the correction\./)).toBeTruthy();
  expect(screen.getByRole('status').textContent).toMatch(/1 already offset by a manual journal/);
});

it('asks for confirmation before recording anything, and Cancel records nothing', async () => {
  const posted = respond([200, refused]);
  await undoAndSeeRefusal();

  fireEvent.click(screen.getByRole('button', { name: 'Confirm JE-2026-00042 is the correction' }));

  expect(await screen.findByText('Confirm the hand correction')).toBeTruthy();
  expect(posted).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByText('Confirm the hand correction')).toBeNull();
  expect(posted).toHaveLength(1);
});

it('records the confirmation for exactly that line and journal, then clears it', async () => {
  const posted = respond(
    [200, refused],
    [200, { success: true, data: { ...OFFSET, offsetJournalId: 'je-hand', offsetEntryNumber: 'JE-2026-00042', runClosed: true } }],
  );
  const onUndone = vi.fn();
  await undoAndSeeRefusal(onUndone);

  fireEvent.click(screen.getByRole('button', { name: 'Confirm JE-2026-00042 is the correction' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm JE-2026-00042' }));

  await vi.waitFor(() => expect(onUndone).toHaveBeenCalledTimes(2));
  expect(posted[1]).toEqual({
    action: 'confirmHandCorrection', runId: 'run-1', transactionId: 'tx-1', offsetJournalId: 'je-hand',
  });
  expect(screen.queryByText(/already offsets this posting/)).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});

it("shows the server's refusal and keeps the line listed", async () => {
  respond(
    [200, refused],
    [400, { success: false, error: { code: 'BAD_REQUEST', message: 'That journal does not offset this posting' } }],
  );
  await undoAndSeeRefusal();

  fireEvent.click(screen.getByRole('button', { name: 'Confirm JE-2026-00042 is the correction' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm JE-2026-00042' }));

  expect(await screen.findByText('That journal does not offset this posting')).toBeTruthy();
  expect(screen.getByText(/JE-2026-00042 already offsets this posting/)).toBeTruthy();
});
