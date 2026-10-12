/**
 * The bank statement import posts the outflows it can code (the auto-post
 * sweep), and a line whose predicted cost centre has since been withdrawn
 * posts without it. bulk-commit returns that as `data.autoPost.warnings`, per
 * bank transaction (PR #688 follow-up F3). The panel LISTS those lines under
 * their file (persistent) and shows one toast, after the run's own toast, that
 * points at the list. Rendered and driven through a real file pick, preview and
 * commit, not grepped.
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/toast', () => ({ notify: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/components/accounting/bank/BankAccountSelector', async () => {
  const React = await import('react');
  return {
    BankAccountSelector: ({ onChange }: { onChange: (id: string, o: unknown) => void }) => {
      React.useEffect(() => {
        onChange('bank-1', { id: 'bank-1', label: '1000 - Bank', accountName: 'Bank', accountCode: '1000', accountNumberLast4: '', parentAccountId: null });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { BulkImportPanel } from '@/components/accounting/bank/BulkImportPanel';

const INACTIVE = 'Line 1: cost centre OLD is inactive and was not applied — the line posts without it.';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

const INACTIVE_PH = 'Line 2: project PH was not applied — it belongs to another FNO than the line\'s CC1.';
const preview = {
  filename: 'sept.csv', detectedBank: 'Generic', extractedAccountNumber: null, accountMatch: 'match',
  dateRange: { from: '2026-09-08', to: '2026-09-09' }, totalParsed: 2, duplicatesVsDb: 0, rowHashes: ['h1', 'h2'],
  sampleTransactions: [], warnings: [],
};
const commit = (autoPost: unknown, warnings: string[] = []) => ({
  filename: 'sept.csv', status: 'imported', bulkImportId: 'b', bulkSequence: 1, batchId: 'batch-1',
  transactionCount: 2, duplicateCount: 0, totalParsed: 2, appliedRules: 0, autoPostSkippedLocked: 0, warnings, autoPost,
});
const dropped = (txId: string, label: string, description: string, warnings = [INACTIVE]) => ({ txId, journalEntryId: `je-${txId}`, label, description, warnings });

/** Pick `names` as files, import them all, and wait for the run's own toast. `answer` is each file's commit data. */
async function importFiles(names: string[], answer: (name: string) => unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const name = init?.body ? (JSON.parse(String(init.body)) as { filename?: string }).filename ?? names[0]! : names[0]!;
    if (String(url).includes('bulk-preview')) return ok({ ...preview, filename: name, rowHashes: [`h-${name}`] });
    if (String(url).includes('bulk-commit')) return ok(answer(name));
    return ok([]);
  });
  const { container } = render(<BulkImportPanel />);
  const input = container.querySelector('input[accept]') as HTMLInputElement;
  const files = names.map((n) => new File(['Date,Description,Amount\n2026-09-08,Acme,-5.00\n'], n, { type: 'text/csv' }));
  fireEvent.change(input, { target: { files } });
  const button = await screen.findByRole('button', { name: new RegExp(`Import ${names.length} statement`) });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(vi.mocked(notify.success).mock.calls.length + vi.mocked(notify.warning).mock.calls.filter(([t]) => t === 'Partial import').length).toBeGreaterThan(0));
  return container;
}
const fileRow = (container: HTMLElement, name: string) => within(container.querySelector(`li:has([title="${name}"])`) as HTMLElement);

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); vi.mocked(notify.success).mockReset(); });
afterEach(() => cleanup());

describe('bulk import panel — an auto-posted line whose cost centre was not applied', () => {
  it('lists the line under its file, with date, amount, description and EVERY warning; the toast only points at it', async () => {
    const c = await importFiles(['a.csv'], () => commit({ warnings: [
      dropped('t1', '2026-10-02 R 500,00', 'DEBIT ORDER GYM', [INACTIVE, INACTIVE_PH]),
      dropped('t2', '2026-10-02 R 500,00', 'DEBIT ORDER INSURANCE'),
    ] }));
    const row = fileRow(c, 'a.csv');
    expect(row.getByText('2 lines posted without their cost centre')).toBeTruthy();
    const items = row.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('DEBIT ORDER GYM');
    expect(items[1]!.textContent).toContain('DEBIT ORDER INSURANCE'); // same day, same amount, told apart
    expect(within(items[0]!).getByText('cost centre OLD not applied (inactive)')).toBeTruthy();
    expect(within(items[0]!).getByText('project PH not applied (another FNO)')).toBeTruthy(); // the 2nd warning of a line
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R 500,00', '+2 more warnings — listed below');
  });

  it('the list stays under the file that produced it, in a many-file import, and there is ONE drop toast', async () => {
    const c = await importFiles(['a.csv', 'b.csv'], (n) => commit({ warnings: n === 'a.csv'
      ? [dropped('t1', '2026-10-02 R 230,00', 'ALPHA')] : [dropped('t2', '2026-10-09 R 115,00', 'BETA')] }));
    expect(fileRow(c, 'a.csv').getByText(/ALPHA/)).toBeTruthy();
    expect(fileRow(c, 'a.csv').queryByText(/BETA/)).toBeNull();
    expect(fileRow(c, 'b.csv').getByText(/BETA/)).toBeTruthy();
    expect(notify.warning).toHaveBeenCalledTimes(1);
  });

  it('the run\'s own toast comes first, then the pointer', async () => {
    await importFiles(['a.csv'], () => commit({ warnings: [dropped('t1', '2026-10-02 R 230,00', 'ALPHA')] }));
    const done = vi.mocked(notify.success).mock.invocationCallOrder[0]!;
    const pointer = vi.mocked(notify.warning).mock.invocationCallOrder[0]!;
    expect(done).toBeLessThan(pointer);
  });

  it('says and lists nothing when every pick landed', async () => {
    const c = await importFiles(['a.csv'], () => commit({ warnings: [] }));
    expect(notify.warning).not.toHaveBeenCalled();
    expect(c.textContent).not.toContain('posted without');
  });

  it('does not toast the import\'s own `warnings` (parse errors, a failed auto-post) as a posting', async () => {
    // bulk-commit's data.warnings are the import's swallowed problems. "Posted — <error>" would read a failed
    // auto-post ("still unposted") as a success.
    await importFiles(['a.csv'], () => commit({ warnings: [] }, [
      'Auto-posting of imported outflows failed — the transactions were imported but are still unposted. Post them from the bank transactions page.',
      'Row 3: could not read the date',
    ]));
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('with both, shows only the dropped picks', async () => {
    const c = await importFiles(['a.csv'], () => commit({ warnings: [dropped('t1', '2026-10-02 R 230,00', 'ALPHA')] }, ['Row 3: could not read the date']));
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith('Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R 230,00', 'See the list below.');
    // the import's own problem is in the file's row, not in the toast
    expect(fileRow(c, 'a.csv').getByText('Row 3: could not read the date')).toBeTruthy();
  });

  it('shows the import\'s own problems in that file\'s row, apart from the dropped picks, and not as a clean success', async () => {
    const FAILED = 'Auto-posting of imported outflows failed — the transactions were imported but are still unposted. Post them from the bank transactions page.';
    const c = await importFiles(['a.csv', 'b.csv'], (n) => n === 'a.csv'
      ? commit({ warnings: [] }, [FAILED, 'Row 3: could not read the date'])
      : commit({ warnings: [dropped('t2', '2026-10-09 R 115,00', 'BETA')] }));
    const a = fileRow(c, 'a.csv');
    expect(a.getByText('Imported with problems')).toBeTruthy();
    expect(a.getByText(FAILED)).toBeTruthy();
    expect(a.getByText('Row 3: could not read the date')).toBeTruthy();
    expect(a.queryByText(/posted without their cost centre/)).toBeNull(); // not the dropped-picks list
    expect(a.getByText(/Imported 2 · check below/)).toBeTruthy(); // the pill is not the plain "Imported 2"
    const b = fileRow(c, 'b.csv');
    expect(b.queryByText('Imported with problems')).toBeNull();
    expect(b.getByText('Imported 2')).toBeTruthy();
    expect(notify.warning).toHaveBeenCalledTimes(1); // only the pick pointer; the import's problems are no "Posted —" toast
    expect(vi.mocked(notify.warning).mock.calls[0]![0]).not.toContain('still unposted');
  });

  it('a malformed dropped-pick element does not blank the panel: the other files and their state stay', async () => {
    const c = await importFiles(['good.csv', 'bad.csv'], (n) => commit({ warnings: n === 'bad.csv'
      ? [null, { txId: 't1', label: '2026-09-01 R 1,00', warnings: 'Line 1: not a list' }, dropped('t2', '2026-09-02 R 2,00', 'OK LINE')] : [] }));
    expect(c.textContent).toContain('good.csv');
    expect(fileRow(c, 'bad.csv').getByText(/OK LINE/)).toBeTruthy();
  });

  it('names the first drop in file order, however the commits finish', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const name = (JSON.parse(String(init?.body ?? '{}')) as { filename?: string }).filename ?? 'a.csv';
      if (String(url).includes('bulk-preview')) return ok({ ...preview, filename: name, rowHashes: [`h-${name}`] });
      if (String(url).includes('bulk-commit')) {
        if (name === 'a.csv') await new Promise((r) => setTimeout(r, 150)); // a finishes AFTER b
        return ok(commit({ warnings: [dropped(`t-${name}`, name === 'a.csv' ? '2026-10-02 R 230,00' : '2026-10-09 R 115,00', name)] }));
      }
      return ok([]);
    });
    const { container } = render(<BulkImportPanel />);
    const input = container.querySelector('input[accept]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: ['a.csv', 'b.csv'].map((n) => new File(['Date,Description,Amount\n2026-09-08,Acme,-5.00\n'], n, { type: 'text/csv' })) } });
    const button = await screen.findByRole('button', { name: /Import 2 statements/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(notify.warning).toHaveBeenCalled());
    expect(vi.mocked(notify.warning).mock.calls[0]![0]).toContain('bank line 2026-10-02 R 230,00');
  });
});
