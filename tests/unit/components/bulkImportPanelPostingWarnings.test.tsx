/**
 * The bank statement import posts the outflows it can code (the auto-post
 * sweep), and a line whose predicted cost centre has since been withdrawn
 * posts without it. bulk-commit returns that as `data.autoPost.warnings`, per
 * bank transaction (PR #688 follow-up F3); the panel must show it. Rendered
 * and driven through a real file pick, preview and commit, not grepped.
 */
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
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

const preview = {
  filename: 'sept.csv', detectedBank: 'Generic', extractedAccountNumber: null, accountMatch: 'match',
  dateRange: { from: '2026-09-08', to: '2026-09-09' }, totalParsed: 2, duplicatesVsDb: 0, rowHashes: ['h1', 'h2'],
  sampleTransactions: [], warnings: [],
};
const commit = (autoPost: unknown, warnings: string[] = []) => ({
  filename: 'sept.csv', status: 'imported', bulkImportId: 'b', bulkSequence: 1, batchId: 'batch-1',
  transactionCount: 2, duplicateCount: 0, totalParsed: 2, appliedRules: 0, autoPostSkippedLocked: 0, warnings, autoPost,
});

async function importOneFile(commitAnswer: unknown) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('bulk-preview')) return ok(preview);
    if (String(url).includes('bulk-commit')) return ok(commitAnswer);
    return ok([]);
  });
  const { container } = render(<BulkImportPanel />);
  const input = container.querySelector('input[accept]') as HTMLInputElement;
  const file = new File(['Date,Description,Amount\n2026-09-08,Acme,-500.00\n'], 'sept.csv', { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
  const button = await screen.findByRole('button', { name: /Import 1 statement/ });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(notify.success).toHaveBeenCalled());
}

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.warning).mockReset(); vi.mocked(notify.success).mockReset(); });
afterEach(() => cleanup());

describe('bulk import panel — an auto-posted line whose cost centre was not applied', () => {
  it('says which centre and why, counted per bank transaction', async () => {
    await importOneFile(commit({ warnings: [
      { txId: 't1', journalEntryId: 'je-1', label: '2026-10-02 R230.00', warnings: [INACTIVE] },
      { txId: 't2', journalEntryId: 'je-2', label: '2026-10-03 R115.00', warnings: [INACTIVE] },
    ] }));
    expect(notify.warning).toHaveBeenCalledWith(
      'Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R230.00', '+1 more: 2026-10-03 R115.00',
    );
  });

  it('says nothing when every pick landed', async () => {
    await importOneFile(commit({ warnings: [] }));
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('does not toast the import\'s own `warnings` (parse errors, a failed auto-post) as a posting', async () => {
    // bulk-commit's data.warnings are the import's swallowed problems. "Posted — <error>" would read a failed
    // auto-post ("still unposted") as a success.
    await importOneFile(commit({ warnings: [] }, [
      'Auto-posting of imported outflows failed — the transactions were imported but are still unposted. Post them from the bank transactions page.',
      'Row 3: could not read the date',
    ]));
    expect(notify.warning).not.toHaveBeenCalled();
  });

  it('with both, shows only the dropped picks', async () => {
    await importOneFile(commit(
      { warnings: [{ txId: 't1', journalEntryId: 'je-1', label: '2026-10-02 R230.00', warnings: [INACTIVE] }] },
      ['Row 3: could not read the date'],
    ));
    expect(notify.warning).toHaveBeenCalledTimes(1);
    expect(notify.warning).toHaveBeenCalledWith(
      'Posted — cost centre OLD not applied (inactive), bank line 2026-10-02 R230.00', undefined,
    );
  });

  it('a many-file import shows ONE toast, naming the bank lines of every file', async () => {
    const line = (day: string, amt: string) => ({ txId: `t-${day}`, journalEntryId: `je-${day}`, label: `${day} ${amt}`, warnings: [INACTIVE] });
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const name = init?.body ? (JSON.parse(String(init.body)) as { filename?: string }).filename ?? 'a.csv' : 'a.csv';
      if (String(url).includes('bulk-preview')) return ok({ ...preview, filename: name, rowHashes: [`h-${name}`] });
      if (String(url).includes('bulk-commit')) {
        return ok(commit({ warnings: [name === 'a.csv' ? line('2026-10-02', 'R230.00') : line('2026-10-09', 'R115.00')] }));
      }
      return ok([]);
    });
    const { container } = render(<BulkImportPanel />);
    const input = container.querySelector('input[accept]') as HTMLInputElement;
    const files = ['a.csv', 'b.csv'].map((n) => new File(['Date,Description,Amount\n2026-09-08,Acme,-5.00\n'], n, { type: 'text/csv' }));
    fireEvent.change(input, { target: { files } });
    const button = await screen.findByRole('button', { name: /Import 2 statements/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(notify.success).toHaveBeenCalled());
    expect(notify.warning).toHaveBeenCalledTimes(1);
    const [title, message] = vi.mocked(notify.warning).mock.calls[0]!;
    expect(title).toMatch(/cost centre OLD not applied \(inactive\), bank line 2026-10-0[29] R(230|115)\.00$/);
    expect(message).toMatch(/^\+1 more: 2026-10-0[29] R(230|115)\.00$/);
    expect(`${title} ${message}`).toContain('R230.00');
    expect(`${title} ${message}`).toContain('R115.00');
  });
});
