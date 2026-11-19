/**
 * Wave 6 OC, review #1620 final breaker M: a bonus run's amounts on the run page. An owner or admin changes one on a
 * draft or calculated bonus run (PATCH, then the page reloads); an approved run, another role or a termination run
 * shows no Change button. The note says that recovering cash already paid happens outside payroll.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: vi.fn(async () => undefined),
  apiErrorMessage: (_e: unknown, m: string) => m,
}));

import { OffCycleBonusAmounts } from '@/components/payroll/offCycle/OffCycleBonusAmounts';

const rows = [{ employeeId: '11111111-1111-1111-1111-111111111111', employeeName: 'Thandi Mokoena', amount: 50_000 }];
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => new Response(JSON.stringify({ data: rows }), { status: 200 }));
});
afterEach(() => cleanup());
const bonus = (status: string) => ({ runKind: 'off_cycle', offCycleReason: 'bonus', status });

describe('OffCycleBonusAmounts', () => {
  it('changes an amount on a calculated bonus run: PATCH with the new amount, then reloads the page', async () => {
    const onChanged = vi.fn();
    render(<OffCycleBonusAmounts runId="r1" run={bonus('calculated')} companyRole="owner" onChanged={onChanged} />);
    expect(await screen.findByText(/recovering the difference from the employee happens outside payroll/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Change the bonus amount for Thandi Mokoena' }));
    fireEvent.change(screen.getByLabelText('Bonus amount for Thandi Mokoena'), { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const call = apiFetch.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(call[0]).toBe('/api/payroll/runs/r1/off-cycle-amounts');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ employeeId: rows[0]!.employeeId, amount: 5000 });
  });

  it('no Change button on an approved run or for another role; nothing at all for a termination run', async () => {
    const changeButtons = async (run: Record<string, unknown>, role: string) => {
      const r = render(<OffCycleBonusAmounts runId="r1" run={run as never} companyRole={role} onChanged={() => undefined} />);
      if (run.offCycleReason === 'bonus') await screen.findByText('Thandi Mokoena');
      const n = screen.queryAllByRole('button', { name: /Change the bonus amount/ }).length;
      r.unmount();
      return n;
    };
    expect(await changeButtons(bonus('draft'), 'admin')).toBe(1);
    expect(await changeButtons(bonus('approved'), 'owner')).toBe(0);
    expect(await changeButtons(bonus('calculated'), 'manager')).toBe(0);
    expect(await changeButtons({ runKind: 'off_cycle', offCycleReason: 'termination', status: 'calculated' }, 'owner')).toBe(0);
  });
});
