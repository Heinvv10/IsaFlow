/**
 * Review #1679 codex 6: the off-cycle form's month picker offers the regular monthly runs the server accepts, its FINAL
 * runs (payRunFinalSql: approved or paid, with an approval stamp), as the list reports them (`final`). A stamped paid
 * run is offered; an approved row without a stamp, a calculated run, an off-cycle or weekly run is not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { useOffCycleSources } from '@/components/payroll/offCycle/useOffCycleSources';
import { payRunIsFinal } from '@/modules/accounting/services/payroll/payRunFinalSql';

const run = (id: string, over: Record<string, unknown>) => ({
  id, periodYear: 2026, periodMonth: 11, runKind: 'regular', payFrequency: 'monthly', status: 'approved', final: true, ...over,
});
const runs = [
  run('approved', {}),
  run('paid', { periodMonth: 10, status: 'paid' }),
  run('unstamped', { periodMonth: 9, final: false }),
  run('calculated', { periodMonth: 8, status: 'calculated', final: false }),
  run('bonus', { runKind: 'off_cycle' }),
  run('weekly', { payFrequency: 'weekly' }),
];
const reply = (url: string) => (url.startsWith('/api/payroll/runs') ? runs : []);

afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('useOffCycleSources: the final regular runs', () => {
  it('offers approved and stamped paid monthly regular runs, as the server judges them', async () => {
    apiFetch.mockImplementation(async (url: string) => new Response(JSON.stringify({ data: reply(url) }), { status: 200 }));
    const { result } = renderHook(() => useOffCycleSources());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.runs.map((r) => r.id)).toEqual(['approved', 'paid']);
  });

  it('the shared predicate: approved or paid, with an approval stamp', () => {
    const at = '2026-11-20T10:00:00Z';
    expect(payRunIsFinal({ status: 'paid', approvedAt: at })).toBe(true);
    expect(payRunIsFinal({ status: 'approved', approvalGrandfatheredAt: at })).toBe(true);
    expect(payRunIsFinal({ status: 'approved' })).toBe(false);
    expect(payRunIsFinal({ status: 'calculated', approvedAt: at })).toBe(false);
  });
});
