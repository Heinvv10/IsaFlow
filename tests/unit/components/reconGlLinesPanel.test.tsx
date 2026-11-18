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

function mount(answer: (u: string) => unknown, onSelect = vi.fn()) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => answer(String(url)) as Response);
  render(<ReconGlLinesPanel reconciliationId="r-1" reloadKey={1} completed={false} selectedId={null} onSelect={onSelect} />);
  return onSelect;
}

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
});
