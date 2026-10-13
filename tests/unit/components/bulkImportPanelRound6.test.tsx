/**
 * BulkImportPanel against wrong-shaped answers, through the real panel (only
 * apiFetch, notify and the account selector are mocked): a lone object or a bare
 * sentence in autoPost.warnings is listed, not dropped; empty-but-wrong-shaped
 * problem lists ({}, [[]], blanks, false, 0) leave a clean import clean; a
 * non-string `reason` on a failed file does not crash the panel; a label-less
 * line still gets the pointer wording; a partial run names its problems in the
 * TITLE (line 2 is the toast's one clipped row). (From the round-6 repros.)
 */
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

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

const S = (c: string) => `Line 1: cost centre ${c} is inactive and was not applied — the line posts without it.`;
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const preview = (name: string) => ({ filename: name, detectedBank: 'Generic', extractedAccountNumber: null, accountMatch: 'match',
  dateRange: { from: '2026-09-08', to: '2026-09-09' }, totalParsed: 1, duplicatesVsDb: 0, rowHashes: [`h-${name}`], sampleTransactions: [], warnings: [] });
const imported = (name: string, extra: Record<string, unknown> = {}) =>
  ({ success: true, data: { filename: name, status: 'imported', transactionCount: 1, warnings: [], autoPost: { warnings: [] }, ...extra } });

type Commit = (name: string) => Response | Promise<Response>;

async function run(files: string[], commit: Commit) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const name = (JSON.parse(String(init?.body ?? '{}')) as { filename?: string }).filename ?? '?';
    if (String(url).includes('bulk-preview')) return json({ success: true, data: preview(name) });
    return commit(name);
  });
  const view = render(<BulkImportPanel />);
  const input = view.container.querySelector('input[accept]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: files.map((n) => new File(['Date,Description,Amount\n2026-09-08,X,-5.00\n'], n, { type: 'text/csv' })) } });
  const button = await screen.findByRole('button', { name: new RegExp(`Import ${files.length} statement`) });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByText(/Bulk import (complete|finished)/)).not.toBeNull(), { timeout: 10000 });
  return view;
}
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
const looksClean = (row: HTMLElement) => within(row).queryByText('Imported 1') !== null && !/problem|cost centre|unposted|failed|check below/i.test(row.textContent ?? '');

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.success).mockClear(); vi.mocked(notify.warning).mockClear(); vi.mocked(notify.error).mockClear(); });
afterEach(() => cleanup());

describe('REPRO 2 — a wrong-shaped autoPost.warnings is DROPPED (data.warnings of the same shape is coerced)', () => {
  it.each([
    ['autoPost.warnings a lone object', { autoPost: { warnings: { txId: 't1', label: '2026-09-08 R 5,00', description: 'X', warnings: [S('OLD')] } } }],
    ['autoPost.warnings elements are sentences', { autoPost: { warnings: [S('OLD')] } }],
  ])('%s: the dropped pick is listed or the file is not shown clean', async (_n, extra) => {
    await run(['a.csv'], (n) => json(imported(n, extra)));
    const row = rowOf('a.csv');
    expect({ clean: looksClean(row), row: row.textContent, pointer: vi.mocked(notify.warning).mock.calls.length })
      .toMatchObject({ clean: false });
  });
});

describe('REPRO 3 — an EMPTY-but-wrong-shaped data.warnings makes a clean import read as having problems', () => {
  it.each([
    ['{}', {}], ['[{}]', [{}]], ['[[]]', [[]]], ['["   "]', ['   ']], ['false', false], ['0', 0],
  ])('data.warnings = %s: the clean file reads clean', async (_n, w) => {
    await run(['a.csv'], (n) => json(imported(n, { warnings: w })));
    const row = rowOf('a.csv');
    const card = screen.getByText(/Bulk import (complete|finished)/).textContent;
    expect({ row: row.textContent, card, success: vi.mocked(notify.success).mock.calls.length })
      .toEqual({ row: expect.not.stringMatching(/problem|check below/), card: 'Bulk import complete', success: 1 });
  });
});

describe('REPRO 4 — (PRE-EXISTING) a non-string data.reason on a failed file crashes the panel', () => {
  it('status failed with reason as an object: the panel survives', async () => {
    let thrown: unknown = null;
    try {
      await run(['a.csv'], () => json({ success: true, data: { filename: 'a.csv', status: 'failed', reason: { code: 'X', message: 'no' } } }));
    } catch (e) { thrown = e; }
    expect({ thrown: thrown ? String(thrown).slice(0, 120) : null }).toEqual({ thrown: null });
  }, 20_000);
});

describe('REPRO 5 — a bank line without a label first: the run\'s pointer toast stops pointing at the list', () => {
  it('line 2 points at the list whatever the label', async () => {
    await run(['a.csv'], (n) => json(imported(n, { autoPost: { warnings: [
      { txId: 't1', description: 'X', warnings: [S('OLD')] },
    ] } })));
    const toast = vi.mocked(notify.warning).mock.calls.at(-1)!;
    expect({ title: toast[0], line2: toast[1] }).toMatchObject({ line2: expect.stringMatching(/below/) });
  });
});

describe('Partial import: the problems count is in the title, line 2 is the base three-count form', () => {
  it('names the files with problems in the title and keeps line 2 short', async () => {
    await run(['bad.csv', 'warn.csv'], (n) => n === 'bad.csv' ? json({ success: false, message: 'Insufficient flows' }, 402)
      : json(imported(n, { warnings: ['Auto-post failed — still unposted'] })));
    const partial = vi.mocked(notify.warning).mock.calls.find(([t]) => String(t).startsWith('Partial import'));
    expect(partial![0]).toBe('Partial import — 1 with problems');
    expect(partial![1]).toBe('1 imported · 1 failed · 0 skipped');
    expect(String(partial![1]).length).toBeLessThanOrEqual(34);
  });

  it('a partial run with no problems keeps the plain title', async () => {
    await run(['bad.csv', 'ok.csv'], (n) => n === 'bad.csv' ? json({ success: false, message: 'Insufficient flows' }, 402) : json(imported(n)));
    expect(vi.mocked(notify.warning).mock.calls.find(([t]) => String(t).startsWith('Partial import'))![0]).toBe('Partial import');
  });
});
