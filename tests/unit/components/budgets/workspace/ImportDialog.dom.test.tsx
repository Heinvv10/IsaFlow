import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImportDialog, type ImportDialogProps } from '@/components/accounting/budgets/workspace/ImportDialog';
import * as client from '@/components/accounting/budgets/workspace/budgetWorkspaceClient';

vi.mock('@/components/accounting/budgets/workspace/budgetWorkspaceClient');

const A1 = '11111111-1111-4111-8111-111111111111';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const preview = {
  updatedAt: 'token-at-preview',
  changes: [{ key: `${A1}||||2026-03`, before: null, after: 1000, possibleRevert: false, currentChangedAt: null }],
  cells: [{ glAccountId: A1, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1000 }],
  counts: { added: 1, changed: 0, cleared: 0, unchanged: 0 }, conflicts: [], errors: [], warnings: [], errorCount: 0, warningCount: 0,
  truncated: false, totals: { before: {}, after: {} },
};
const props = (over: Partial<ImportDialogProps> = {}): ImportDialogProps => ({
  open: true, onClose: vi.fn(), versionId: 'v1', months: ['2026-03'], accountLabels: new Map([[A1, '4000 Sales']]), memberLabels: new Map(),
  dirtyCount: 0, commitImport: vi.fn().mockResolvedValue({ ok: true, updatedAt: 't2', saved: 1, deleted: 0, chunks: 1 }), onImported: vi.fn(), ...over,
});
const file = (name: string, size = 100, type = XLSX) => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const pick = (f: File) => fireEvent.change(screen.getByLabelText(/Excel file/), { target: { files: [f] } });

beforeEach(() => {
  vi.mocked(client.previewImport).mockReset().mockResolvedValue({ ok: true, data: preview as never });
});
afterEach(cleanup);

it('refuses a file that is not .xlsx without calling the server', async () => {
  render(<ImportDialog {...props()} />);
  pick(file('budget.csv', 100, 'text/csv'));
  expect((await screen.findByRole('alert')).textContent).toMatch(/\.xlsx/);
  expect(client.previewImport).not.toHaveBeenCalled();
});

it('refuses a file over 10 MB without calling the server', async () => {
  render(<ImportDialog {...props()} />);
  pick(file('big.xlsx', 10 * 1024 * 1024 + 1));
  expect((await screen.findByRole('alert')).textContent).toMatch(/over 10 MB/);
  expect(client.previewImport).not.toHaveBeenCalled();
});

it('previews the picked file for the version, then commits the cells with the preview token', async () => {
  const p = props();
  render(<ImportDialog {...p} />);
  const f = file('budget.xlsx');
  pick(f);
  await screen.findByTestId('import-counts');
  expect(client.previewImport).toHaveBeenCalledWith('v1', f);
  fireEvent.click(screen.getByRole('button', { name: /^commit/i }));
  await waitFor(() => expect(p.commitImport).toHaveBeenCalledWith(preview.cells, 'token-at-preview'));
  await waitFor(() => expect(p.onImported).toHaveBeenCalledTimes(1));
  expect(p.onClose).toHaveBeenCalled();
});

it('reports a mid-chain failure honestly and re-runs the preview from the same file', async () => {
  const p = props({
    commitImport: vi.fn().mockResolvedValue({
      ok: false, failure: { ok: false, kind: 'stale', message: 'Someone else saved this budget.', currentUpdatedAt: 't9', versionStatus: 'draft' },
      failedChunk: 1, chunks: 3, committed: [], updatedAt: 't1', saved: 20000, deleted: 0,
    }),
  });
  render(<ImportDialog {...p} />);
  const f = file('budget.xlsx');
  pick(f);
  await screen.findByTestId('import-counts');
  fireEvent.click(screen.getByRole('button', { name: /^commit/i }));
  const alert = await screen.findByText(/chunk 2 of 3 failed; earlier chunks were saved/i);
  expect(alert.textContent).toMatch(/Someone else saved this budget/);
  expect(p.onImported).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /re-run preview/i }));
  await waitFor(() => expect(client.previewImport).toHaveBeenCalledTimes(2));
  expect(vi.mocked(client.previewImport).mock.calls[1]![1]).toBe(f);
});

it('blocks Commit while the grid has unsaved edits', async () => {
  render(<ImportDialog {...props({ dirtyCount: 2 })} />);
  pick(file('budget.xlsx'));
  await screen.findByTestId('import-counts');
  expect(screen.getByText(/2 unsaved edits/)).toBeTruthy();
  expect((screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows a refused preview with when to retry', async () => {
  vi.mocked(client.previewImport).mockResolvedValue({ ok: false, kind: 'rateLimited', message: 'Too many imports.', retryAfter: 30 });
  render(<ImportDialog {...props()} />);
  pick(file('budget.xlsx'));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Too many imports\. Try again in 30 s/);
});
