/**
 * K-071 r20 — the auto-post Undo tells the user what actually happened.
 *
 * `undoRun` records a run undone only when no line was skipped, so a run with
 * a reconciled line stays listed. The panel treated every 2xx as success and
 * reloaded silently: Undo did nothing visible, forever. A 409 (a peer holds
 * the lines) and every other failure rendered "[object Object]", because the
 * error envelope's `error` is an object, not a string.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { AutoPostRunsPanel } from '@/components/accounting/bank-transactions/AutoPostRunsPanel';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));

const RUN = { id: 'run-1', source: 'categorization', postedCount: 2, totalAmount: 120, createdAt: '2026-09-10', undoneAt: null };

function respondToUndo(status: number, body: unknown): void {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => (
    init?.method === 'POST'
      ? new Response(JSON.stringify(body), { status })
      : new Response(JSON.stringify({ data: { runs: [RUN] } }))
  ));
}

async function clickUndo(onUndone = vi.fn()): Promise<void> {
  render(<AutoPostRunsPanel onUndone={onUndone} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

it('says how many lines were reversed and skipped when the run is only partly undone', async () => {
  respondToUndo(200, { success: true, data: { reversed: 1, skipped: 1, alreadyUndone: 0, undone: false } });
  await clickUndo();

  const notice = await screen.findByRole('status');
  expect(notice.textContent).toMatch(/Reversed 1 line;/);
  expect(notice.textContent).toMatch(/1 could not be undone/);
  expect(notice.textContent).toMatch(/Unreconcile those lines/);
});

it('shows nothing extra when the whole run was undone', async () => {
  respondToUndo(200, { success: true, data: { reversed: 2, skipped: 0, alreadyUndone: 0, undone: true } });
  const onUndone = vi.fn();
  await clickUndo(onUndone);

  await vi.waitFor(() => expect(onUndone).toHaveBeenCalled());
  expect(screen.queryByRole('status')).toBeNull();
});

it('answers a 409 as busy, not as a failure', async () => {
  respondToUndo(409, { success: false, error: { code: 'CONFLICT', message: 'Bank transaction x is being allocated by another request.' } });
  await clickUndo();

  expect(await screen.findByText(/Another request is working on this run's lines — try again in a moment\./)).toBeTruthy();
});

it("shows the server's message for any other failure, not [object Object]", async () => {
  respondToUndo(400, { success: false, error: { code: 'BAD_REQUEST', message: 'Run already undone' } });
  await clickUndo();

  expect(await screen.findByText('Run already undone')).toBeTruthy();
});
