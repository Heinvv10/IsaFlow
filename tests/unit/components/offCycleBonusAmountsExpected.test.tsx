/**
 * Gate item 4 on 06c106a94d: the bonus amount edit sends, as expectedAmount, the amount the editor saw when editing
 * started, never the row as last refetched: the row refreshing mid-edit with another admin's amount must not make the
 * save overwrite it. The server answers that save 409.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: Response, m: string) => { if (!res.ok) throw new Error(m); },
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { OffCycleBonusAmounts } from '@/components/payroll/offCycle/OffCycleBonusAmounts';

const EMP = '11111111-1111-1111-1111-111111111111';
afterEach(() => { cleanup(); apiFetch.mockReset(); });

describe('OffCycleBonusAmounts: expectedAmount', () => {
  it('is the amount when editing started, even after the row refreshes with another admin\'s', async () => {
    let stored = 50_000;
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Response(JSON.stringify({ success: false, error: { message: 'changed by someone else' } }), { status: 409 });
      return new Response(JSON.stringify({ data: [{ employeeId: EMP, employeeName: 'Thandi Mokoena', amount: stored }] }), { status: 200 });
    });
    const run = (status: string) => ({ runKind: 'off_cycle', offCycleReason: 'bonus', status });
    const r = render(<OffCycleBonusAmounts runId="r1" run={run('calculated') as never} companyRole="owner" onChanged={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change the bonus amount for Thandi Mokoena' }));
    fireEvent.change(screen.getByLabelText('Bonus amount for Thandi Mokoena'), { target: { value: '5000' } });
    // Another admin's correction lands; the list refetches mid-edit.
    stored = 60_000;
    r.rerender(<OffCycleBonusAmounts runId="r1" run={run('draft') as never} companyRole="owner" onChanged={() => undefined} />);
    await waitFor(() => expect(apiFetch.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'PATCH').length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')).toBe(true));
    const patch = apiFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ employeeId: EMP, amount: 5000, expectedAmount: 50_000 });
  });
});
