/**
 * useSarsOverview: only the newest load writes state (a slow earlier response never overwrites a
 * newer one), a refresh does not show the page spinner, and marksUnavailable comes from the
 * calendar response. calendarCounts never counts a marked item as overdue.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: { ok: boolean }, msg: string) => { if (!res.ok) throw new Error(msg); },
  apiErrorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f),
}));

import { calendarCounts, useSarsOverview } from '@/components/accounting/sars/useSarsOverview';
import type { CalendarItem } from '@/components/accounting/sars/ComplianceCalendarTable';

const ev = (description: string, status: CalendarItem['status'] = 'overdue'): CalendarItem =>
  ({ eventType: 'EMP201_DUE', dueDate: '2026-01-07', periodStart: '2025-12-01', periodEnd: '2025-12-31', description, status });
const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });

/** Each call to the calendar URL gets the next deferred response; submissions resolve at once. */
function deferredCalendar() {
  const pending: Array<(v: unknown) => void> = [];
  apiFetch.mockImplementation((url: string) => url.includes('sars-compliance')
    ? new Promise((r) => pending.push(r))
    : Promise.resolve(ok({ items: [] })));
  return pending;
}

beforeEach(() => { apiFetch.mockReset(); });

describe('useSarsOverview', () => {
  it('a slow earlier load cannot overwrite a newer one', async () => {
    const pending = deferredCalendar();
    const { result } = renderHook(() => useSarsOverview());
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]!(ok({ events: [ev('newer')], marksUnavailable: false })); });
    await waitFor(() => expect(result.current.events[0]?.description).toBe('newer'));
    await act(async () => { pending[0]!(ok({ events: [ev('older')], marksUnavailable: true })); });
    expect(result.current.events[0]?.description).toBe('newer');
    expect(result.current.marksUnavailable).toBe(false);
    expect(result.current.loading).toBe(false);
  });

  it('a refresh does not show the page spinner', async () => {
    const pending = deferredCalendar();
    const { result } = renderHook(() => useSarsOverview());
    await act(async () => { pending[0]!(ok({ events: [], marksUnavailable: false })); });
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => { result.current.refresh(); });
    expect(result.current.loading).toBe(false);
  });

  it('marksUnavailable comes from the calendar response', async () => {
    const pending = deferredCalendar();
    const { result } = renderHook(() => useSarsOverview());
    await act(async () => { pending[0]!(ok({ events: [ev('a')], marksUnavailable: true })); });
    await waitFor(() => expect(result.current.marksUnavailable).toBe(true));
  });
});

describe('calendarCounts', () => {
  it('a marked item is completed, never overdue', () => {
    expect(calendarCounts([ev('late'), ev('marked', 'completed'), ev('marked 2', 'completed')]))
      .toMatchObject({ overdue: 1, completed: 2 });
  });
});
