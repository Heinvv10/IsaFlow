import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'c1', financialYearStart: 3 } }) }));
import { usePeriodActions } from '@/components/accounting/fiscal-periods/usePeriodActions';
import { useFiscalCalendar, resetFiscalCalendarCache } from '@/components/ui/useFiscalCalendar';

const list = (status: string) => new Response(JSON.stringify({ success: true, data: [
  { periodName: 'Mar 2026', fiscalYear: 2027, periodNumber: 1, startDate: '2026-03-01', endDate: '2026-03-31', status },
] }), { status: 200 });
const okAction = () => new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });

let listStatus = 'closed';
beforeEach(() => {
  resetFiscalCalendarCache(); listStatus = 'closed';
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url: RequestInfo | URL) =>
    String(url).includes('fiscal-periods-action') ? okAction() : list(listStatus));
});

/** Reopening a period must not leave the date fields refusing it for the next minute. */
describe('fiscal-period actions refresh the date fields', () => {
  it('a reopen drops the cached periods so the next form sees the period open', async () => {
    const first = renderHook(() => useFiscalCalendar());
    await vi.waitFor(() => expect(first.result.current.check('2026-03-15', '2026-11-22').level).toBe('block'));
    first.unmount();

    listStatus = 'open';
    const actions = renderHook(() => usePeriodActions({ reload: async () => undefined, showSentence: () => undefined, clearSelection: () => undefined }));
    await act(async () => { await actions.result.current.runSingle('p1', 'reopen'); });

    const next = renderHook(() => useFiscalCalendar());
    await vi.waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.check('2026-03-15', '2026-11-22').level).toBeNull();
  });
  it('a bulk reopen does the same', async () => {
    const first = renderHook(() => useFiscalCalendar());
    await vi.waitFor(() => expect(first.result.current.ready).toBe(true));
    first.unmount();
    vi.mocked(apiFetch).mockImplementation(async (url: RequestInfo | URL) =>
      String(url).includes('fiscal-periods-action')
        ? new Response(JSON.stringify({ success: true, data: { results: [{ id: 'p1', ok: true }], okCount: 1, total: 1 } }), { status: 200 })
        : list('open'));
    const actions = renderHook(() => usePeriodActions({ reload: async () => undefined, showSentence: () => undefined, clearSelection: () => undefined }));
    await act(async () => { await actions.result.current.runBulk('bulk_reopen', ['p1']); });
    const next = renderHook(() => useFiscalCalendar());
    await vi.waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(next.result.current.check('2026-03-15', '2026-11-22').level).toBeNull();
  });
});
