/**
 * BulkImportPanel against awkward answers, through the real panel (only apiFetch,
 * notify and the account selector are mocked): a wrong-shaped problem list is
 * coerced, never dropped (the file must not read clean); a mixed run names the
 * files with problems in the toast and card; warnings are listed once per line;
 * a retried file carries no stale error; ties are ordered by the line id.
 * (From the round-5 adversarial repros.)
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
  await add(view.container, files);
  await commitAll(files.length);
  return view;
}
async function add(container: HTMLElement, files: string[]) {
  const input = container.querySelector('input[accept]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: files.map((n) => new File(['Date,Description,Amount\n2026-09-08,X,-5.00\n'], n, { type: 'text/csv' })) } });
}
async function commitAll(n: number) {
  const button = await screen.findByRole('button', { name: new RegExp(`Import ${n} statement`) });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(screen.queryByText(/Bulk import (complete|finished)/)).not.toBeNull(), { timeout: 3000 });
}
const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(notify.success).mockClear(); vi.mocked(notify.warning).mockClear(); vi.mocked(notify.error).mockClear(); });
afterEach(() => cleanup());

describe('REPRO 1 — a malformed problem list is read as a clean import', () => {
  it.each([
    ['data.warnings as a string', { warnings: 'Auto-post failed for 3 lines — still unposted' }],
    ['data.warnings as objects', { warnings: [{ error: 'Auto-post failed for 3 lines — still unposted' }] }],
    ['autoPost.warnings[i].warnings as a string', { autoPost: { warnings: [{ txId: 't1', label: '2026-09-08 R 5,00', description: 'X', warnings: S('OLD') }] } }],
  ])('%s: the file is not reported as a clean success', async (_n, extra) => {
    await run(['a.csv'], (n) => json(imported(n, extra)));
    const row = rowOf('a.csv');
    const clean = within(row).queryByText('Imported 1') !== null
      && !/problem|cost centre|unposted|failed/i.test(row.textContent ?? '');
    expect({ clean, row: row.textContent, success: vi.mocked(notify.success).mock.calls, warn: vi.mocked(notify.warning).mock.calls })
      .toMatchObject({ clean: false });
  });
});

describe('REPRO 2 — mixed run: a failure hides the "with problems" count everywhere but the row', () => {
  it('the run toast and the summary card still name the file with problems', async () => {
    await run(['bad.csv', 'warn.csv', 'clean.csv'], (n) => n === 'bad.csv' ? json({ success: false, message: 'Insufficient flows' }, 402)
      : json(imported(n, n === 'warn.csv' ? { warnings: ['Auto-post failed — 3 lines still unposted'] } : {})));
    const card = screen.getByText(/Bulk import (complete|finished)/).closest('div')!.parentElement!.textContent ?? '';
    const toast = JSON.stringify([...vi.mocked(notify.warning).mock.calls, ...vi.mocked(notify.success).mock.calls]);
    expect({ card, toast }).toMatchObject({ card: expect.stringMatching(/problem/i), toast: expect.stringMatching(/problem/i) });
  });
});

describe('REPRO 3 — duplicate warning sentence on one bank line: row and toast disagree', () => {
  it('the row lists each warning once (the toast already dedupes)', async () => {
    await run(['a.csv'], (n) => json(imported(n, { autoPost: { warnings: [{ txId: 't1', label: '2026-09-08 R 5,00', description: 'X', warnings: [S('OLD'), S('OLD')] }] } })));
    const facts = within(rowOf('a.csv')).getAllByText(/cost centre OLD/);
    const toastLine2 = vi.mocked(notify.warning).mock.calls.map((c) => c[1]);
    expect({ rowCount: facts.length, toastLine2 }).toEqual({ rowCount: 1, toastLine2: ['See the list below.'] });
  });
});

describe('REPRO 4 — retrying a failed file: the old error stays on a clean import', () => {
  it('after fail → retry → import, the row carries no stale error', async () => {
    let attempt = 0;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const name = (JSON.parse(String(init?.body ?? '{}')) as { filename?: string }).filename ?? '?';
      if (String(url).includes('bulk-preview')) return json({ success: true, data: preview(name) });
      attempt++;
      return attempt === 1 ? json({ success: false, message: 'Server exploded' }, 500) : json(imported(name));
    });
    const { container } = render(<BulkImportPanel />);
    await add(container, ['a.csv']);
    await commitAll(1);
    fireEvent.click(within(rowOf('a.csv')).getByRole('button', { name: 'Retry parse' }));
    await commitAll(1);
    await waitFor(() => expect(within(rowOf('a.csv')).queryByText('Imported 1')).not.toBeNull());
    expect(rowOf('a.csv').textContent).not.toContain('Server exploded');
  });
});

describe('controls (expected GREEN)', () => {
  it.each([
    ['null data', () => json({ success: true, data: null })],
    ['body null', () => json('null')],
    ['un-enveloped imported', () => json({ filename: 'a.csv', status: 'imported', transactionCount: 1, warnings: ['W1'] })],
    ['non-JSON 200', () => new Response('<html>gateway</html>', { status: 200 })],
    ['500', () => json({ success: false, message: 'boom' }, 500)],
    ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['autoPost null', () => json(imported('a.csv', { autoPost: null }))],
    ['autoPost.warnings object', () => json(imported('a.csv', { autoPost: { warnings: { 0: 1 } } }))],
  ])('%s: panel survives and says something true', async (n, r) => {
    await run(['a.csv'], r as Commit);
    const row = rowOf('a.csv').textContent ?? '';
    if (n === 'un-enveloped imported') expect(row).toContain('check below');
    else if (n.startsWith('autoPost')) expect(row).toContain('Imported 1');
    else expect(row).toContain('Failed');
  });

  it('XSS: description/warning text is rendered inert', async () => {
    const x = '<img src=x onerror="window.__pwn=1">';
    await run(['a.csv'], (n) => json(imported(n, { warnings: [x], autoPost: { warnings: [{ txId: 't', label: x, description: x, warnings: [x] }] } })));
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it('toast title is the first drop in FILE order even when file 1 finishes last', async () => {
    await run(['one.csv', 'two.csv'], async (n) => {
      if (n === 'one.csv') await new Promise((r) => setTimeout(r, 200));
      return json(imported(n, { autoPost: { warnings: [{ txId: n, label: n === 'one.csv' ? '2026-09-09 R 1,00' : '2026-09-01 R 1,00', description: n, warnings: [S(n === 'one.csv' ? 'ONE' : 'TWO')] }] } }));
    });
    const calls = vi.mocked(notify.warning).mock.calls;
    expect(calls.at(-1)![0]).toContain('ONE');
  });

  it('second run: the first run\'s problem row stays flagged, the clean second run reports clean', async () => {
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      const name = (JSON.parse(String(init?.body ?? '{}')) as { filename?: string }).filename ?? '?';
      if (String(url).includes('bulk-preview')) return json({ success: true, data: preview(name) });
      return json(imported(name, name === 'a.csv' ? { warnings: ['W'] } : {}));
    });
    const { container } = render(<BulkImportPanel />);
    await add(container, ['a.csv']);
    await commitAll(1);
    await add(container, ['b.csv']);
    await commitAll(1);
    expect(rowOf('a.csv').textContent).toContain('check below');
    expect(rowOf('b.csv').textContent).not.toContain('check below');
    expect(screen.getByText('Bulk import complete')).toBeTruthy();
  });

  it('huge: 20,000 import warnings render without hanging (timing printed)', async () => {
    const t0 = performance.now();
    await run(['a.csv'], (n) => json(imported(n, { warnings: Array.from({ length: 20000 }, (_, i) => `Auto-post failed for line ${i}`) })));
    expect(rowOf('a.csv').querySelectorAll('li').length).toBeLessThanOrEqual(20000);
    expect(performance.now() - t0).toBeLessThan(50_000);
  }, 60_000);
});

describe('REPRO 5 — tie order follows the server (whose SELECT has no ORDER BY)', () => {
  it('two identical debit orders on one day: row order and toast title do not depend on the order the sweep sent them', async () => {
    const a = { txId: 'tx-a', label: '2026-09-08 R 499,00', description: 'DEBIT ORDER VODACOM', warnings: [S('OLD')] };
    const b = { txId: 'tx-b', label: '2026-09-08 R 499,00', description: 'DEBIT ORDER VODACOM', warnings: [S('GONE')] };
    const seen: Array<{ row: string; title: string }> = [];
    for (const order of [[a, b], [b, a]]) {
      vi.mocked(notify.warning).mockClear();
      await run(['a.csv'], (n) => json(imported(n, { autoPost: { warnings: order } })));
      seen.push({ row: rowOf('a.csv').textContent ?? '', title: String(vi.mocked(notify.warning).mock.calls.at(-1)![0]) });
      cleanup();
    }
    expect(seen[1]).toEqual(seen[0]);
  });
});

describe('mixed run: failed and with-problems both named', () => {
  it('the Partial-import toast and the card carry the with-problems count', async () => {
    await run(['bad.csv', 'warn.csv'], (n) => n === 'bad.csv' ? json({ success: false, message: 'Insufficient flows' }, 402)
      : json(imported(n, { warnings: ['Auto-post failed — still unposted'] })));
    const partial = vi.mocked(notify.warning).mock.calls.find(([t]) => t === 'Partial import');
    expect(partial![1]).toBe('1 imported · 1 failed · 0 skipped · 1 with problems');
    expect(screen.getByText(/1 imported · 0 skipped · 1 failed · 1 with problems/)).toBeTruthy();
  });
});
