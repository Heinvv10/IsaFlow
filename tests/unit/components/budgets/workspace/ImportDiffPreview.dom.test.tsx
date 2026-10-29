import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ImportDiffPreview, type ImportDiffPreviewProps } from '@/components/accounting/budgets/workspace/ImportDiffPreview';
import type { ImportPreview } from '@/modules/accounting/services/budgets/budgetImportDiff';

afterEach(cleanup);

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const key = (a: string, m: string) => `${a}||||${m}`;
const NOW = Date.parse('2026-10-27T10:00:00Z');

const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
  updatedAt: '2026-10-27T09:00:00.000001Z',
  changes: [
    { key: key(A1, '2026-03'), before: null, after: 1000, possibleRevert: false, currentChangedAt: null },
    { key: key(A1, '2026-04'), before: 500, after: 700, possibleRevert: true, currentChangedAt: '2026-10-27T09:55:00.000000Z' },
    { key: key(A2, '2026-03'), before: 300, after: null, possibleRevert: false, currentChangedAt: '2026-10-27T08:00:00.000000Z' },
  ],
  cells: [
    { glAccountId: A1, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 1000 },
    { glAccountId: A1, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: 700 },
    { glAccountId: A2, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: null, clear: true },
  ],
  counts: { added: 1, changed: 1, cleared: 1, unchanged: 9 },
  conflicts: [{ key: key(A1, '2026-04'), downloaded: 500, current: 600, after: 700 }],
  errors: [], warnings: [], errorCount: 0, warningCount: 0, truncated: false,
  totals: { before: { months: {} as never, fy: {} as never }, after: { months: {} as never, fy: {} as never } },
  ...over,
});

const props = (over: Partial<ImportDiffPreviewProps> = {}): ImportDiffPreviewProps => ({
  preview: preview(),
  months: ['2026-03', '2026-04'],
  accountLabels: new Map([[A1, '4000 Sales'], [A2, '5000 Purchases']]),
  memberLabels: new Map(),
  nowMs: NOW,
  busy: false,
  failure: null,
  onCommit: vi.fn(),
  onRerun: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});

const commitButton = () => screen.getByRole('button', { name: /^commit/i });
const withErrors = () => preview({
  errors: [{ row: 7, column: 'Account code', message: 'Unknown account code "9999"' }], errorCount: 1,
});

it('shows the added / changed / cleared / unchanged counts', () => {
  render(<ImportDiffPreview {...props()} />);
  const counts = screen.getByTestId('import-counts');
  expect(within(counts).getByText(/1 added/)).toBeTruthy();
  expect(within(counts).getByText(/1 changed/)).toBeTruthy();
  expect(within(counts).getByText(/1 cleared/)).toBeTruthy();
  expect(within(counts).getByText(/9 unchanged/)).toBeTruthy();
});

it('groups the changes by account and highlights the changed cells', () => {
  render(<ImportDiffPreview {...props()} />);
  expect(screen.getByText('4000 Sales')).toBeTruthy();
  expect(screen.getByText('5000 Purchases')).toBeTruthy();
  expect(document.querySelectorAll('[data-changed="true"]').length).toBe(3);
});

it('flags a possible revert and a conflict with how long ago the cell changed', () => {
  render(<ImportDiffPreview {...props()} />);
  expect(screen.getAllByText(/possible revert/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/changed 5 min ago/i).length).toBeGreaterThan(0);
  expect(screen.getByText(/conflict/i)).toBeTruthy();
});

it('disables Commit while errors are listed, and lists them', () => {
  const onCommit = vi.fn();
  render(<ImportDiffPreview {...props({ preview: withErrors(), onCommit })} />);
  expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(commitButton());
  expect(onCommit).not.toHaveBeenCalled();
  expect(screen.getByText(/Unknown account code "9999"/)).toBeTruthy();
});

it('enables Commit with errors only after "import valid rows only" is ticked, then sends the cells', () => {
  const onCommit = vi.fn();
  const p = props({ preview: withErrors(), onCommit });
  render(<ImportDiffPreview {...p} />);
  fireEvent.click(screen.getByLabelText(/import valid rows only/i));
  expect((commitButton() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(commitButton());
  expect(onCommit).toHaveBeenCalledWith(p.preview.cells);
});

it('enables Commit with no errors', () => {
  const onCommit = vi.fn();
  render(<ImportDiffPreview {...props({ onCommit })} />);
  expect(screen.queryByLabelText(/import valid rows only/i)).toBeNull();
  fireEvent.click(commitButton());
  expect(onCommit).toHaveBeenCalledTimes(1);
});

it('disables Commit when there is nothing to change', () => {
  render(<ImportDiffPreview {...props({ preview: preview({ changes: [], cells: [], counts: { added: 0, changed: 0, cleared: 0, unchanged: 12 } }) })} />);
  expect((commitButton() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/no changes/i)).toBeTruthy();
});

it('says how many errors are not listed when the list is truncated, and shows warnings', () => {
  const p = preview({
    errors: [{ row: 2, column: 'x', message: 'bad' }], errorCount: 450, truncated: true,
    warnings: [{ row: 3, column: 'y', message: 'header account holds amounts' }], warningCount: 1,
  });
  render(<ImportDiffPreview {...props({ preview: p })} />);
  expect(screen.getByText(/450 errors/)).toBeTruthy();
  expect(screen.getByText(/only the first 1 listed/i)).toBeTruthy();
  expect(screen.getByText(/header account holds amounts/)).toBeTruthy();
});

it('reports a mid-chain failure honestly and offers a re-run', () => {
  const onRerun = vi.fn();
  render(<ImportDiffPreview {...props({ onRerun, failure: { message: 'The budget was changed by someone else.', failedChunk: 2, chunks: 3 } })} />);
  expect(screen.getByRole('alert').textContent).toMatch(/chunk 2 of 3 failed; earlier chunks were saved/i);
  fireEvent.click(screen.getByRole('button', { name: /re-run preview/i }));
  expect(onRerun).toHaveBeenCalledTimes(1);
});
