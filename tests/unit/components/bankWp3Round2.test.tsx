/**
 * WP3 round 2: the REAL useBankTxBusy hook (same-tick calls, row overlap), the real BankTxFilters with busy state
 * (disabled, aria-busy, the cross-key rule, the live region), the row buttons' busyIds wiring, the amount input's
 * validation, and the accessibility of the active-filters chip and the tabs.
 */
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@/utils/toast', () => ({ notify: toast }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { useBankTxBusy, BUSY_HOLD_CAP_MS } from '@/components/accounting/bank-transactions/useBankTxBusy';
import { BankTxFilters, type BankTxFiltersProps } from '@/components/accounting/bank-transactions/BankTxFilters';
import { BankTxRowActions } from '@/components/accounting/bankTx/BankTxRowActions';
import { ActiveFiltersChip } from '@/components/accounting/bank-transactions/ActiveFiltersChip';
import { BankTxTabs } from '@/components/accounting/bank-transactions/BankTxTabs';
import { DebouncedAmountInput, AMOUNT_DEBOUNCE_MS } from '@/components/accounting/bank-transactions/DebouncedAmountInput';
import type { BankTx } from '@/components/accounting/BankTxTable';

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { Object.values(toast).forEach((f) => f.mockReset()); });

describe('useBankTxBusy: a hung request cannot hold its lines for good', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('after the cap the key and rows are released, the user is told, and a retry runs; the late finish of the hung one changes nothing', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBankTxBusy());
    let finishHung!: () => void;
    const hung = new Promise<void>((r) => { finishHung = r; });
    let p1!: Promise<unknown>;
    act(() => { p1 = result.current.run('delete', () => hung, ['t1']); });
    expect(result.current.busy.has('row:t1')).toBe(true);
    await act(async () => { vi.advanceTimersByTime(BUSY_HOLD_CAP_MS - 1); });
    expect(result.current.busy.has('delete')).toBe(true); // not yet
    await act(async () => { vi.advanceTimersByTime(2); });
    expect(result.current.busy.size).toBe(0);
    expect(toast.warning).toHaveBeenCalledWith('This is taking too long', expect.any(String));
    // a retry on the same key/row now runs, and holds
    const retry = vi.fn(() => new Promise<string>(() => undefined));
    act(() => { void result.current.run('delete', retry, ['t1']); });
    expect(retry).toHaveBeenCalledTimes(1);
    expect(result.current.busy.has('row:t1')).toBe(true);
    // the first request finally answers: it must NOT release the retry's hold
    await act(async () => { finishHung(); await p1; });
    expect(result.current.busy.has('delete')).toBe(true);
    expect(result.current.busy.has('row:t1')).toBe(true);
  });
  it('a healthy LONG batch keeps its hold: 4 requests of 25 s each (100 s in all) never lose it, and nothing warns', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBankTxBusy());
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.run('batch-allocate', async () => {
        for (let i = 0; i < 4; i += 1) {
          result.current.touch({ rows: ['t1', 't2', 't3', 't4'] }); // request i starts (callAction touches the hook)
          await wait(25_000);
          result.current.touch({ key: 'batch-allocate' }); // ... and finishes
          result.current.setProgress({ key: 'batch-allocate', done: i + 1, total: 4 });
        }
      }, ['t1', 't2', 't3', 't4']);
    });
    for (const at of [25_000, 50_000, 75_000]) { // 75 s in: well past a 60 s TOTAL cap
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
      expect(result.current.busy.has('batch-allocate'), `still held after ${at / 1000}s`).toBe(true);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); await done; }); // the 4th request ends at 100 s
    expect(toast.warning).not.toHaveBeenCalled();
    expect(result.current.busy.size).toBe(0);
  });

  it('a progress step alone is activity too', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBankTxBusy());
    act(() => { void result.current.run('batch-allocate', () => new Promise<void>(() => undefined), ['t1']); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_HOLD_CAP_MS - 1000); });
    act(() => { result.current.setProgress({ key: 'batch-allocate', done: 1, total: 4 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(BUSY_HOLD_CAP_MS - 1000); });
    expect(result.current.busy.has('batch-allocate')).toBe(true); // 119 s since the start, 59 s since the last step
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.busy.size).toBe(0); // 60 s of silence: released
    expect(toast.warning).toHaveBeenCalledWith('This is taking too long', expect.any(String));
  });

  it('a request that finishes in time never warns', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useBankTxBusy());
    await act(async () => { await result.current.run('review', async () => 1); });
    await act(async () => { vi.advanceTimersByTime(BUSY_HOLD_CAP_MS * 2); });
    expect(toast.warning).not.toHaveBeenCalled();
  });
});

describe('useBankTxBusy (the real hook)', () => {
  const gate = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };

  it('two same-tick run() calls with one key: the function runs ONCE', async () => {
    const { result } = renderHook(() => useBankTxBusy());
    const fn = vi.fn(async () => 'done'); const g = gate();
    fn.mockImplementation(async () => { await g.p; return 'done'; });
    let a: Promise<string | undefined>, b: Promise<string | undefined>;
    act(() => { a = result.current.run('delete', fn); b = result.current.run('delete', fn); }); // no await between them
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await b!).toBeUndefined(); // refused
    await act(async () => { g.go(); await a!; });
    expect(await a!).toBe('done');
  });

  it('busy lists the running keys and the touched rows, and empties when the run ends (even on a throw)', async () => {
    const { result } = renderHook(() => useBankTxBusy());
    const g = gate();
    let p!: Promise<unknown>;
    act(() => { p = result.current.run('batch-allocate', async () => { await g.p; throw new Error('boom'); }, ['t1', 't2']).catch(() => undefined); });
    expect([...result.current.busy].sort()).toEqual(['batch-allocate', 'row:t1', 'row:t2']);
    expect(result.current.isBusy('batch-allocate')).toBe(true);
    await act(async () => { g.go(); await p; });
    expect(result.current.busy.size).toBe(0);
    const again = vi.fn(async () => 1);
    await act(async () => { await result.current.run('batch-allocate', again); });
    expect(again).toHaveBeenCalledTimes(1); // a failed run does not wedge the key
  });

  it('a different operation on a row another operation holds is refused with a message; other rows are free', async () => {
    const { result } = renderHook(() => useBankTxBusy());
    const g = gate(); const other = vi.fn(async () => 'x'); const free = vi.fn(async () => 'y');
    let first!: Promise<unknown>;
    act(() => { first = result.current.run('batch-allocate', () => g.p, ['t1', 't2']); });
    let r1: unknown, r2: unknown;
    await act(async () => { r1 = await result.current.run('accept:t1', other, ['t1']); r2 = await result.current.run('accept:t9', free, ['t9']); });
    expect(r1).toBeUndefined(); expect(other).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('already being processed'), expect.any(String));
    expect(r2).toBe('y'); expect(free).toHaveBeenCalledTimes(1);
    await act(async () => { g.go(); await first; });
    await act(async () => { await result.current.run('accept:t1', other, ['t1']); });
    expect(other).toHaveBeenCalledTimes(1); // free again once the batch ended
  });
});

const filterProps = (over: Partial<BankTxFiltersProps> = {}): BankTxFiltersProps => ({
  tab: 'new', page: 1, total: 3, pageSize: 25, selectedCount: 2, selectedBank: 'b1', smartRunning: false, showCC: false, showBU: false, showBatchEdit: false,
  searchTerm: '', fromDate: '', toDate: '', fromAmount: '', toAmount: '', sortOrder: 'desc', allocationFilter: 'all', txType: 'all', allocType: 'all',
  hasSuggestion: 'all', reconFilter: 'all', busy: new Set(), progress: null,
  onRefresh: vi.fn(), onBulkAccept: vi.fn(), onBatchAccept: vi.fn(), onBatchDelete: vi.fn(), onToggleBatchEdit: vi.fn(), onExport: vi.fn(), onExportAll: vi.fn(),
  onApplyRules: vi.fn(), onDownloadReport: vi.fn(), onSearchChange: vi.fn(), onFromDateChange: vi.fn(), onToDateChange: vi.fn(), onFromAmountChange: vi.fn(),
  onToAmountChange: vi.fn(), onSortOrderChange: vi.fn(), onAllocationFilterChange: vi.fn(), onTxTypeChange: vi.fn(), onAllocTypeChange: vi.fn(),
  onHasSuggestionChange: vi.fn(), onReconFilterChange: vi.fn(), onToggleCC: vi.fn(), onToggleBU: vi.fn(), ...over,
});
const btn = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('BankTxFilters with busy state (the real component)', () => {
  it('idle: the three bulk buttons are enabled and not aria-busy', () => {
    render(<BankTxFilters {...filterProps()} />);
    for (const n of [/Mark as Reviewed/, /Batch Allocate/, /Delete/]) { expect(btn(n).disabled).toBe(false); expect(btn(n).getAttribute('aria-busy')).toBeNull(); }
  });

  it.each([['review', /Mark as Reviewed/], ['batch-allocate', /Allocating|Batch Allocate/], ['delete', /Delete/]] as const)(
    '%s running: its own button is aria-busy, and ALL THREE bulk buttons are disabled (they act on the same lines)', (key, name) => {
      render(<BankTxFilters {...filterProps({ busy: new Set([key]), progress: key === 'batch-allocate' ? { key, done: 1, total: 3 } : null })} />);
      expect(btn(name).getAttribute('aria-busy')).toBe('true');
      expect(btn(/Mark as Reviewed/).disabled).toBe(true);
      expect(btn(/Delete/).disabled).toBe(true);
      expect(screen.getByRole('button', { name: /Allocating|Batch Allocate/ })).toHaveProperty('disabled', true);
    });

  it('"Allocating i of n" is announced in a polite live region that exists before the batch starts', () => {
    const { rerender } = render(<BankTxFilters {...filterProps()} />);
    const live = screen.getByTestId('bank-tx-progress-live');
    expect(live.getAttribute('role')).toBe('status'); expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    rerender(<BankTxFilters {...filterProps({ busy: new Set(['batch-allocate']), progress: { key: 'batch-allocate', done: 1, total: 3 } })} />);
    expect(screen.getByTestId('bank-tx-progress-live').textContent).toBe('Allocating 2 of 3');
  });
});

describe('row buttons: busyIds wiring', () => {
  const base = { id: 'tx-1', transactionDate: '2026-06-01', description: 'W', amount: -5 } as BankTx;
  const show = (busyIds: Set<string>, extra: Partial<BankTx> = {}, status = 'imported', sel: unknown = { type: 'account', entityId: 'g1', label: 'x', vatCode: 'none' }) =>
    render(<table><tbody><tr><BankTxRowActions tx={{ ...base, ...extra, status }} label="W" sel={sel as never} isNew isAllocated={status === 'allocated'} isExcluded={false}
      table={{ onAccept: vi.fn(), onExclude: vi.fn(), onUnmatch: vi.fn(), onSplit: vi.fn(), onReverse: vi.fn(), onAskClient: vi.fn(), busyIds } as never} /></tr></tbody></table>);

  it('Accept is disabled and aria-busy while its own accept runs', () => {
    show(new Set(['accept:tx-1']));
    const b = screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement;
    expect(b.disabled).toBe(true); expect(b.getAttribute('aria-busy')).toBe('true');
  });
  it('Accept is disabled while a BATCH holds the row (row:<id>), and enabled when idle', () => {
    show(new Set(['batch-allocate', 'row:tx-1']));
    expect((screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup(); show(new Set());
    expect((screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('another row being busy does not disable this one', () => {
    show(new Set(['accept:other', 'row:other']));
    expect((screen.getByRole('button', { name: /^Accept/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('DebouncedAmountInput validation', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
  const type = (v: string) => { const onCommit = vi.fn(); render(<DebouncedAmountInput id="a" label="Min R" value="" placeholder="0" onCommit={onCommit} />); const i = screen.getByLabelText('Min R') as HTMLInputElement; fireEvent.change(i, { target: { value: v } }); return { onCommit, i }; };

  it('the field refuses a negative at the browser level (min=0)', () => {
    render(<DebouncedAmountInput id="a" label="Min R" value="" placeholder="0" onCommit={vi.fn()} />);
    expect((screen.getByLabelText('Min R') as HTMLInputElement).min).toBe('0');
  });
  it.each(['1e3', '-5', '1.23456', '12.5.1'])('%j is flagged on the field and NEVER sent (the list is not blanked by a 400)', (bad) => {
    const { onCommit, i } = type(bad);
    act(() => { vi.advanceTimersByTime(AMOUNT_DEBOUNCE_MS + 10); }); fireEvent.blur(i); fireEvent.keyDown(i, { key: 'Enter' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(i.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/Enter an amount/);
    expect(i.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
  });
  it('a valid amount is sent and shows no error; fixing a bad draft clears the error', () => {
    const { onCommit, i } = type('1e3');
    fireEvent.change(i, { target: { value: '1250.5' } });
    act(() => { vi.advanceTimersByTime(AMOUNT_DEBOUNCE_MS + 10); });
    expect(onCommit).toHaveBeenCalledWith('1250.5');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(i.getAttribute('aria-invalid')).toBeNull();
  });
  it('".5" is a valid amount: sent, no error', () => {
    const { onCommit } = type('.5');
    act(() => { vi.advanceTimersByTime(AMOUNT_DEBOUNCE_MS + 10); });
    expect(onCommit).toHaveBeenCalledWith('.5');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('emptying the field is a valid "no bound"', () => {
    const onCommit = vi.fn();
    render(<DebouncedAmountInput id="a" label="Min R" value="50" placeholder="0" onCommit={onCommit} />);
    const i = screen.getByLabelText('Min R'); fireEvent.change(i, { target: { value: '' } }); fireEvent.blur(i);
    expect(onCommit).toHaveBeenCalledWith('');
  });
});

describe('an invalid amount draft does not survive Clear or an account switch', () => {
  it('the amount input drops its unsent draft when the filters\' resetKey changes', () => {
    const props = filterProps();
    const { rerender } = render(<BankTxFilters {...props} resetKey={0} />);
    const min = () => screen.getByLabelText('Min R') as HTMLInputElement;
    fireEvent.change(min(), { target: { value: '-5' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    rerender(<BankTxFilters {...props} resetKey={0} />); // an ordinary re-render keeps the draft
    expect(min().value).toBe('-5');
    rerender(<BankTxFilters {...props} resetKey={1} />); // Clear / account switch
    expect(min().value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('useBankTxFilters bumps resetKey on clear() and on resetForAccount(), not on a plain change', async () => {
    const { useBankTxFilters } = await import('@/components/accounting/bank-transactions/useBankTxFilters');
    const { result } = renderHook(() => useBankTxFilters(vi.fn()));
    const start = result.current.resetTick;
    act(() => { result.current.setFromAmount('5'); });
    expect(result.current.resetTick).toBe(start);
    act(() => { result.current.clear(); });
    expect(result.current.resetTick).toBe(start + 1);
    act(() => { result.current.resetForAccount(); });
    expect(result.current.resetTick).toBeGreaterThan(start + 1);
  });
});

describe('accessibility', () => {
  it('the active-filters chip prints the filter names as text on the page (no hover needed)', () => {
    render(<ActiveFiltersChip labels={['From 2026-01-01', 'Type: spent']} onClear={vi.fn()} />);
    const names = screen.getByTestId('active-filters-names');
    expect(names.textContent).toContain('From 2026-01-01'); expect(names.textContent).toContain('Type: spent');
    expect(screen.getByTestId('active-filters').textContent).toContain('2 filters active');
    expect(names.getAttribute('aria-label')).toBe('Active filters');
  });
  it('the status tabs are a tablist of role=tab with aria-selected (not aria-current buttons)', () => {
    render(<BankTxTabs tab="reviewed" onTab={vi.fn()} />);
    expect(screen.getByRole('tablist')).toBeTruthy();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.every((t) => t.getAttribute('aria-current') === null)).toBe(true);
  });
});
