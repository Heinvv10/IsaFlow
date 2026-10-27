/**
 * The 409 dialog (spec §7.3). Part 1 drives the dialog alone: wording, which choices a stale or a
 * locked refusal offers, and that every choice is the user's. Part 2 drives the real store + hook
 * through a 409 on save (apiFetch mocked at the network edge): the unsaved cells survive the
 * refusal, "re-apply" reloads and flags the cell someone else changed, and a locked refusal copies
 * the version into a new draft with my cells on top.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BudgetWorkspace } from '@/components/accounting/budgets/workspace/BudgetWorkspace';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { StaleVersionDialog, staleHeadline } from '@/components/accounting/budgets/workspace/StaleVersionDialog';
import type { StaleState } from '@/components/accounting/budgets/workspace/types';
import { fail, installNetwork, isModel, isSave, ok } from './workspaceHarness';
import { ID, TOKEN, gridModel } from './gridFixture';

vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() }, push: vi.fn() }) }));

// Unmount first, then leave a fetch that refuses: a late effect must never reach a real server.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test over'); }));
});

const stale = (over: Partial<StaleState> = {}): StaleState => ({
  kind: 'stale', message: 'This budget version changed since you loaded it', currentUpdatedAt: '2026-10-26T18:05:00.000001Z',
  versionStatus: 'draft', failedChunk: 0, chunks: 1, dirtyCount: 3, ...over,
});

describe('StaleVersionDialog alone', () => {
  it('says the changes are kept and offers re-apply, discard and download', async () => {
    const onChoose = vi.fn(async () => null);
    const onClose = vi.fn();
    render(<StaleVersionDialog stale={stale()} onChoose={onChoose} onClose={onClose} />);
    expect(screen.getByTestId('stale-dialog')).toHaveTextContent('This budget was changed since you opened it. Your 3 unsaved changes are kept.');
    expect(screen.queryByRole('button', { name: 'Copy into a new draft version' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reload and re-apply mine' }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('reapply'));
    fireEvent.click(screen.getByRole('button', { name: 'Download my changes (.xlsx)' }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('download'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('locked: re-apply is replaced by "Copy into a new draft version"', async () => {
    const onChoose = vi.fn(async () => null);
    render(<StaleVersionDialog stale={stale({ kind: 'locked', versionStatus: null, currentUpdatedAt: null })} onChoose={onChoose} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Reload and re-apply mine' })).toBeNull();
    expect(screen.getByTestId('stale-dialog')).toHaveTextContent('This budget was locked since you opened it.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy into a new draft version' }));
    await waitFor(() => expect(onChoose).toHaveBeenCalledWith('copy'));
  });

  it('nothing is discarded unless the user picks it; Escape keeps editing', () => {
    const onChoose = vi.fn(async () => null);
    const onClose = vi.fn();
    render(<StaleVersionDialog stale={stale()} onChoose={onChoose} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('a chained commit names the refused part; a failed choice is shown', async () => {
    const onChoose = vi.fn(async () => 'Could not load the budget.');
    render(<StaleVersionDialog stale={stale({ chunks: 3, failedChunk: 1 })} onChoose={onChoose} onClose={vi.fn()} />);
    expect(screen.getByTestId('stale-chunk')).toHaveTextContent('Part 2 of 3 was refused. Part 1 was saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Discard mine and reload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the budget.');
  });

  it('headline follows the version status the server reported', () => {
    expect(staleHeadline(stale({ versionStatus: 'approved' }))).toBe('This budget was changed or approved since you opened it.');
    expect(staleHeadline(stale({ versionStatus: 'locked' }))).toBe('This budget was locked since you opened it.');
  });
});

// ── Part 2: through the workspace, its real hook, store and grid ─────────────

const T2 = '2026-10-26T18:05:00.000001Z';
const REV1 = buildLayout(gridModel().accounts, gridModel().year.monthKeys).rows.find((r) => r.key === `acct:${ID.rev1}`)!.index;
const marchRev1 = () => document.querySelector<HTMLElement>(`[data-pos="${REV1}:0"]`)!;

/** Workspace loaded; R1 000 in 1000 / March typed over as R250 (one unsaved change). */
async function editedWorkspace() {
  const net = installNetwork();
  render(<BudgetWorkspace />);
  await screen.findByRole('grid', { name: 'Budget' });
  fireEvent.doubleClick(marchRev1());
  const editor = screen.getByRole('textbox', { name: '1000 Account 1000 Mar 2026 budget' });
  fireEvent.change(editor, { target: { value: '250' } });
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(marchRev1()).toHaveAttribute('data-dirty', 'true');
  expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');
  return net;
}

describe('StaleVersionDialog in the workspace', () => {
  it('a stale 409 keeps the unsaved cell; re-apply reloads, flags the cell someone else changed, and saves with the new token', async () => {
    const net = await editedWorkspace();
    net.on(isSave, () => fail(409, 'This budget version changed since you loaded it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: T2, status: 'draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = await screen.findByTestId('stale-dialog');
    expect(dialog).toHaveTextContent('Your 1 unsaved change is kept.');
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');
    expect(marchRev1()).toHaveAttribute('data-dirty', 'true');

    // Someone else saved R1 100 into the same cell.
    const m = gridModel();
    net.on(isModel, () => ok({ ...m, updatedAt: T2, version: { ...m.version!, updatedAt: T2 },
      cells: m.cells.map((c) => (c.glAccountId === ID.rev1 && c.month === m.year.monthKeys[0] ? { ...c, amount: 1100 } : c)) }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload and re-apply mine' }));
    await waitFor(() => expect(screen.queryByTestId('stale-dialog')).toBeNull());
    await waitFor(() => expect(marchRev1()).toHaveAttribute('data-conflict', 'true'));
    expect(marchRev1()).toHaveAttribute('data-dirty', 'true');
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');

    net.on(isSave, () => ok({ updatedAt: '2026-10-26T18:06:00.000001Z', saved: 1, deleted: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByTestId('save-bar-count')).toBeNull());
    const saves = net.sent.filter((s) => isSave(s.url)).map((s) => s.body as { expectedUpdatedAt: string; cells: Array<{ amount: number }> });
    expect(saves.map((b) => b.expectedUpdatedAt)).toEqual([TOKEN, T2]);
    expect(saves[1]!.cells).toEqual([expect.objectContaining({ glAccountId: ID.rev1, amount: 250 })]);
  });

  it('"Keep editing" closes the dialog and the unsaved cell stays', async () => {
    const net = await editedWorkspace();
    net.on(isSave, () => fail(409, 'This budget version changed since you loaded it', { code: 'BUDGET_VERSION_STALE', currentUpdatedAt: T2, status: 'approved' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByTestId('stale-dialog')).toBeNull();
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');
    expect(marchRev1()).toHaveAttribute('data-dirty', 'true');
    expect(net.sent.filter((s) => isModel(s.url))).toHaveLength(1);
  });

  it('a locked 409: "Copy into a new draft version" copies it and puts my cell on the copy, unsaved', async () => {
    const net = await editedWorkspace();
    const copyId = 'b0000000-0000-4000-8000-0000000000c1';
    net.on(isSave, () => fail(409, 'This budget version is locked', { code: 'BUDGET_VERSION_LOCKED' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByTestId('stale-dialog');
    expect(screen.queryByRole('button', { name: 'Reload and re-apply mine' })).toBeNull();
    const m = gridModel();
    const copy = { ...m.version!, id: copyId, name: 'Original (my changes)', kind: 'reforecast' as const, isPrimary: false, updatedAt: T2 };
    net.on((u, method) => method === 'POST' && u.endsWith(`/budget-versions/${ID.version}/copy`), () => ok(copy));
    net.on((u) => isModel(u) && u.includes(`version_id=${copyId}`), () => ok({ ...m, version: copy, updatedAt: T2 }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy into a new draft version' })); });
    await waitFor(() => expect(screen.queryByTestId('stale-dialog')).toBeNull());
    const copyReq = net.sent.find((s) => s.url.endsWith('/copy'))!;
    expect(copyReq.body).toMatchObject({ kind: 'reforecast', name: expect.stringContaining('Original (my changes') });
    await waitFor(() => expect(marchRev1()).toHaveAttribute('data-dirty', 'true'));
    expect(screen.getByTestId('save-bar-count')).toHaveTextContent('1 unsaved change');

    net.on(isSave, () => ok({ updatedAt: '2026-10-26T18:07:00.000001Z', saved: 1, deleted: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(net.sent.filter((s) => isSave(s.url))).toHaveLength(2));
    expect(net.sent.filter((s) => isSave(s.url))[1]!.body).toMatchObject({ versionId: copyId, expectedUpdatedAt: T2 });
  });
});
