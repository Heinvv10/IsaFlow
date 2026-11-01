// The auto-loading report pages share one rule: a report runs once per set of params, never over a refused date,
// and what is on screen is hidden the moment a refused date leaves it disagreeing with the selection.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatedDateField, useDateGate, type DateGate } from '@/components/forms/GatedDateField';
import { useGatedReportLoad, type ReportLoad } from '@/components/reports/useGatedReportLoad';
import { typeDate } from '../helpers/dateFields';

afterEach(cleanup);

const gate = (blocked: boolean) => ({ blocked }) as DateGate;
type Props = { query: string; blocked: boolean; load: ReportLoad };
const start = (load: ReportLoad, query = 'a') => renderHook(
  (p: Props) => useGatedReportLoad(p.query, gate(p.blocked), p.load),
  { initialProps: { query, blocked: false, load } },
);
const succeed = () => vi.fn<ReportLoad>(async () => true);

describe('useGatedReportLoad', () => {
  it('runs once for a set of params, however often the page renders', async () => {
    const load = succeed();
    const { rerender } = start(load);
    rerender({ query: 'a', blocked: false, load });
    rerender({ query: 'a', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not run while blocked, then runs the changed params once', () => {
    const load = succeed();
    const { rerender } = start(load);
    rerender({ query: 'b', blocked: true, load });
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ query: 'b', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('skips the run when a refusal ends with the params unchanged', () => {
    const load = succeed();
    const { rerender } = start(load);
    rerender({ query: 'a', blocked: true, load });
    rerender({ query: 'a', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a failed run is retried when a refusal ends, and does not loop until then', async () => {
    const load = vi.fn<ReportLoad>(async () => false);
    const { rerender } = start(load);
    await act(async () => { await Promise.resolve(); });
    rerender({ query: 'a', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(1);
    rerender({ query: 'a', blocked: true, load });
    rerender({ query: 'a', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a failure of an older run does not clear the record of the newer one', async () => {
    let failOld: (ok: boolean) => void = () => undefined;
    const load = vi.fn<ReportLoad>().mockImplementationOnce(() => new Promise((resolve) => { failOld = resolve; }))
      .mockImplementation(async () => true);
    const { rerender } = start(load);
    rerender({ query: 'b', blocked: false, load });
    await act(async () => { failOld(false); await Promise.resolve(); });
    rerender({ query: 'b', blocked: true, load });
    rerender({ query: 'b', blocked: false, load });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('an older run is told it is no longer the latest', () => {
    const load = succeed();
    const { rerender } = start(load);
    const first = load.mock.calls[0]![0];
    expect(first()).toBe(true);
    rerender({ query: 'b', blocked: false, load });
    expect(first()).toBe(false);
    expect(load.mock.calls[1]![0]()).toBe(true);
  });

  it('is stale only while blocked over params that were not run', () => {
    const load = succeed();
    const { rerender, result } = start(load);
    expect(result.current).toBe(false);
    rerender({ query: 'a', blocked: true, load });
    expect(result.current).toBe(false);
    rerender({ query: 'b', blocked: true, load });
    expect(result.current).toBe(true);
    rerender({ query: 'a', blocked: true, load });
    expect(result.current).toBe(false);
  });

  it('a date the parent sets over a refusal runs, though the field binds after the parent reads the gate', async () => {
    const load = succeed();
    function Page() {
      const [date, setDate] = useState('2026-04-30');
      const dates = useDateGate();
      useGatedReportLoad(date, dates, load);
      return (
        <>
          <GatedDateField gate={dates} gateKey="to" label="To" value={date} onValue={setDate} />
          <button type="button" onClick={() => setDate('2026-05-31')}>May</button>
        </>
      );
    }
    render(<Page />);
    typeDate(screen.getByRole('textbox', { name: 'To' }), 'zz');
    await waitFor(() => expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'To' }).getAttribute('aria-invalid')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'May' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});
