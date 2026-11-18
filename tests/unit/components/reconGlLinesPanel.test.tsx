/**
 * The reconciliation screen's GL panel (ReconGlLinesPanel): it reads the recon-scoped list, says so when the server
 * cut it (never a partial list shown as the whole), and searches on the server. The list's SQL is proven in
 * tests/integration/recon-gl-lines-list.int.test.ts.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { ReconGlLinesPanel } from '@/components/accounting/bank/ReconGlLinesPanel';
import { ok } from '../helpers/d2CensusG4';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const line = (n: number) => ({ id: `l${n}`, debit: 0, credit: 10 + n, description: `RGL line ${n}`, entryDate: '2026-03-01',
  entryNumber: `JE-${n}` });
const urls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u));

function mount(answer: (u: string) => unknown, onSelect = vi.fn(), opts: { selectedId?: string; completed?: boolean } = {}) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => answer(String(url)) as Response);
  render(<ReconGlLinesPanel reconciliationId="r-1" reloadKey={1} completed={opts.completed ?? false}
    selectedId={opts.selectedId ?? null} onSelect={onSelect} />);
  return onSelect;
}
/** A response the test releases by hand, so two requests can answer in either order. */
function deferred() {
  let release: (r: Response) => void = () => undefined;
  const promise = new Promise<Response>((r) => { release = r; });
  return { promise, release };
}
const searchOf = (u: string) => new URL(u, 'http://x').searchParams.get('search');

describe('ReconGlLinesPanel', () => {
  it('reads the reconciliation-scoped list, not the journal-entries list', async () => {
    mount(() => ok({ lines: [line(1)], total: 1, truncated: false }));
    expect(await screen.findByText('RGL line 1')).toBeTruthy();
    expect(urls()).toEqual(['/api/accounting/bank-reconciliation-gl-lines?reconciliationId=r-1']);
    expect(screen.getByText(/GL Lines \(1 unmatched\)/)).toBeTruthy();
    expect(screen.queryByText(/Search to find an older one/)).toBeNull();
  });

  it('a cut list names how many lines there are and asks for a search', async () => {
    mount(() => ok({ lines: [line(1), line(2)], total: 812, truncated: true }));
    expect(await screen.findByText('Showing the newest 2 of 812 lines. Search to find an older one.')).toBeTruthy();
    expect(screen.getByText(/GL Lines \(812 unmatched\)/)).toBeTruthy();
  });

  it('the search runs on the server and shows what it returns', async () => {
    mount((u) => ok(u.includes('search=')
      ? { lines: [line(99)], total: 1, truncated: false }
      : { lines: [line(1)], total: 812, truncated: true }));
    await screen.findByText('RGL line 1');
    fireEvent.change(screen.getByLabelText('Search GL lines'), { target: { value: ' 109.00 ' } });
    expect(await screen.findByText('RGL line 99')).toBeTruthy();
    expect(urls().at(-1)).toBe('/api/accounting/bank-reconciliation-gl-lines?reconciliationId=r-1&search=109.00');
    expect(screen.queryByText('RGL line 1')).toBeNull();
  });

  it('selecting a line hands its id to the screen', async () => {
    const onSelect = mount(() => ok({ lines: [line(7)], total: 1, truncated: false }));
    fireEvent.click(await screen.findByText('RGL line 7'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('l7'));
  });

  it('the search box says how an amount is matched', async () => {
    mount(() => ok({ lines: [], total: 0, truncated: false }));
    expect(screen.getByPlaceholderText('Search description, entry number or amount (1234.50)')).toBeTruthy();
  });

  it('a search that no longer lists the selected line clears the selection', async () => {
    const onSelect = mount((u) => ok(u.includes('search=')
      ? { lines: [line(99)], total: 1, truncated: false }
      : { lines: [line(1)], total: 1, truncated: false }), vi.fn(), { selectedId: 'l1' });
    await screen.findByText('RGL line 1');
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Search GL lines'), { target: { value: '109' } });
    await screen.findByText('RGL line 99');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });

  it('a failed reload clears the selection with the rows', async () => {
    const onSelect = mount((u) => (u.includes('search=')
      ? new Response('', { status: 500 })
      : ok({ lines: [line(1)], total: 1, truncated: false })), vi.fn(), { selectedId: 'l1' });
    await screen.findByText('RGL line 1');
    fireEvent.change(screen.getByLabelText('Search GL lines'), { target: { value: 'x' } });
    expect(await screen.findByText(/Could not load the bank ledger lines/)).toBeTruthy();
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });

  it('a completed reconciliation says so instead of "0 unmatched", and reads no list', async () => {
    mount(() => ok({ lines: [], total: 0, truncated: false }), vi.fn(), { completed: true });
    expect(screen.getByText('Reconciliation completed — no lines to match')).toBeTruthy();
    expect(screen.queryByText(/unmatched/)).toBeNull();
    expect(screen.queryByLabelText('Search GL lines')).toBeNull();
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('an older search answering last does not replace the newer one', async () => {
    const pending: Record<string, ReturnType<typeof deferred>> = {};
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
      const q = searchOf(String(url));
      if (!q) return ok({ lines: [line(1)], total: 1, truncated: false });
      pending[q] = deferred();
      return pending[q]!.promise;
    });
    render(<ReconGlLinesPanel reconciliationId="r-1" reloadKey={1} completed={false} selectedId={null} onSelect={vi.fn()} />);
    await screen.findByText('RGL line 1');
    const box = screen.getByLabelText('Search GL lines');
    fireEvent.change(box, { target: { value: 'older' } });
    await waitFor(() => expect(pending.older).toBeDefined());
    fireEvent.change(box, { target: { value: 'newer' } });
    await waitFor(() => expect(pending.newer).toBeDefined());
    pending.newer!.release(ok({ lines: [line(2)], total: 1, truncated: false }));
    await screen.findByText('RGL line 2');
    pending.older!.release(ok({ lines: [line(3)], total: 1, truncated: false }));
    // Give the older answer every chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('RGL line 3')).toBeNull();
    expect(screen.getByText('RGL line 2')).toBeTruthy();
  });

  it('typing is debounced: one request for the settled text, none for the keystrokes on the way', async () => {
    mount(() => ok({ lines: [line(1)], total: 1, truncated: false }));
    await screen.findByText('RGL line 1');
    const box = screen.getByLabelText('Search GL lines');
    for (const v of ['4', '43', '432', '4321']) fireEvent.change(box, { target: { value: v } });
    await waitFor(() => expect(urls().some((u) => searchOf(u) === '4321')).toBe(true));
    expect(urls().map(searchOf).filter(Boolean)).toEqual(['4321']);
  });
});
