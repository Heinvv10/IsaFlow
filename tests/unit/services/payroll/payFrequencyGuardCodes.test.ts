/**
 * Wave 6 FQc (review #1575 L1): what an assignment to a weekly or fortnightly employee refuses. Any 38xx (fringe benefits,
 * 3801 loans included) and 3701 (travel allowance) are costed on monthly rules only, and so is a percent-of-RFI row;
 * every other code is assignable. A monthly employee is never refused. The SQL runs for real in w6-fqc-rev1575.int.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: (t: string) => t }) }));

import { assertComponentAssignableAtFrequency } from '@/modules/accounting/services/payroll/payrollFrequencyGuard';

/** A db that answers the component's code, then the employee's frequency. */
const db = (code: string, frequency: string) => {
  const answers = [[{ code }], [{ employee_number: 'E1', pay_frequency: frequency }]];
  return vi.fn(async () => answers.shift() ?? []) as never;
};
const outcome = (code: string, frequency: string, percentOfRfi: number | null = null) =>
  assertComponentAssignableAtFrequency('c', 'e', 'k', percentOfRfi, db(code, frequency)).then(() => 'ok', (e: { code?: string }) => e.code);

describe('assertComponentAssignableAtFrequency', () => {
  it.each(['3801', '3802', '3810', '3817', '3825', '3828', '3701'])('%s on a weekly employee is refused', async (code) => {
    expect(await outcome(code, 'weekly')).toBe('PAY_FREQUENCY_REFUSED');
  });
  it.each(['3601', '3605', '3606', '3702', '3713', '4001', '4005'])('%s on a fortnightly employee is assignable', async (code) => {
    expect(await outcome(code, 'fortnightly')).toBe('ok');
  });
  it('a percent-of-RFI row is refused whatever its code; a monthly employee never is', async () => {
    expect(await outcome('4001', 'weekly', 0.075)).toBe('PAY_FREQUENCY_REFUSED');
    expect(await outcome('3810', 'monthly')).toBe('ok');
  });
});
