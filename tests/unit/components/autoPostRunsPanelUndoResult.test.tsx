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

/** Each POST answers with the next reply in order; the run stays listed. */
function respondToUndo(...replies: Array<[number, unknown]>): void {
  const queue = [...replies];
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ data: { runs: [RUN] } }));
    const [status, body] = queue.shift()!;
    return new Response(JSON.stringify(body), { status });
  });
}

const skips = (reconciled: number, contended: number, failed: number) => ({ reconciled, contended, failed });
const partial = (skippedBy: ReturnType<typeof skips>) => ({
  success: true,
  data: { reversed: 1, skipped: skippedBy.reconciled + skippedBy.contended + skippedBy.failed, skippedBy, alreadyUndone: 0, undone: false },
});
const complete = { success: true, data: { reversed: 2, skipped: 0, skippedBy: skips(0, 0, 0), alreadyUndone: 0, undone: true } };

async function clickUndo(onUndone = vi.fn()): Promise<void> {
  render(<AutoPostRunsPanel onUndone={onUndone} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

it('says how many lines were reversed and, per reason, why the rest were not', async () => {
  respondToUndo([200, partial(skips(1, 2, 3))]);
  await clickUndo();

  const notice = (await screen.findByRole('status')).textContent;
  expect(notice).toMatch(/^Reversed 1 line\. Not undone:/);
  expect(notice).toMatch(/1 reconciled — unreconcile them first/);
  expect(notice).toMatch(/2 in use by another request — try again in a moment/);
  expect(notice).toMatch(/3 could not be reversed .* check those lines/);
});

// K-071 r21 review: a line that is not reconciled must not be told to
// unreconcile — the remedy follows the reason.
it('names only the reasons that apply', async () => {
  respondToUndo([200, partial(skips(0, 0, 1))]);
  await clickUndo();

  const notice = (await screen.findByRole('status')).textContent;
  expect(notice).toMatch(/1 could not be reversed/);
  expect(notice).not.toMatch(/unreconcile/i);
  expect(notice).not.toMatch(/another request/);
});

// A retry that completes the run must not leave the previous partial notice
// on screen, claiming lines are still outstanding.
it('clears the partial notice when a retry completes the run', async () => {
  respondToUndo([200, partial(skips(0, 1, 0))], [200, complete]);
  const onUndone = vi.fn();
  await clickUndo(onUndone);
  await screen.findByRole('status');

  fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
  await vi.waitFor(() => expect(onUndone).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('status')).toBeNull();
});

it('shows nothing extra when the whole run was undone', async () => {
  respondToUndo([200, complete]);
  const onUndone = vi.fn();
  await clickUndo(onUndone);

  await vi.waitFor(() => expect(onUndone).toHaveBeenCalled());
  expect(screen.queryByRole('status')).toBeNull();
});

it('answers a 409 as busy, not as a failure', async () => {
  respondToUndo([409, { success: false, error: { code: 'CONFLICT', message: 'Bank transaction x is being allocated by another request.' } }]);
  await clickUndo();

  expect(await screen.findByText(/Another request is working on this run's lines — try again in a moment\./)).toBeTruthy();
});

it("shows the server's message for any other failure, not [object Object]", async () => {
  respondToUndo([400, { success: false, error: { code: 'BAD_REQUEST', message: 'Run already undone' } }]);
  await clickUndo();

  expect(await screen.findByText('Run already undone')).toBeTruthy();
});
