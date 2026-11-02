/**
 * The day a pay run reads its employees' components on.
 *
 * The run used to build `new Date(year, month - 1, 28)` at LOCAL midnight and the reader rendered it with
 * toISOString(), so on the SAST production host every run read as at the 27th and a once-off dated the 28th or later
 * was never paid. The read date is now the period's last day, built as a plain 'YYYY-MM-DD' string, and the reader
 * binds that string as it is. Each case runs with the process in SAST and in UTC.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const bound: unknown[][] = [];
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => { bound.push(values); return []; }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { payrollRunReadDate } from '@/modules/accounting/services/payroll/payrollRunReadDate';
import { getEmployeeComponents } from '@/modules/accounting/services/payroll/payrollComponentService';

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
  bound.length = 0;
});

const LAST_DAYS_2026 = ['31', '28', '31', '30', '31', '30', '31', '31', '30', '31', '30', '31'];

describe.each(['Africa/Johannesburg', 'UTC'] as const)('process in %s', (zone) => {
  it('the zone is really in force: the old construction reads the 27th in SAST and the 28th in UTC', () => {
    process.env.TZ = zone;
    expect(new Date(2026, 2, 28).toISOString().slice(0, 10)).toBe(zone === 'UTC' ? '2026-03-28' : '2026-03-27');
  });

  it('is the last calendar day of every month of 2026', () => {
    process.env.TZ = zone;
    for (let month = 1; month <= 12; month++) {
      expect(payrollRunReadDate({ year: 2026, month })).toBe(`2026-${String(month).padStart(2, '0')}-${LAST_DAYS_2026[month - 1]}`);
    }
  });

  it('follows the Gregorian leap rule for February', () => {
    process.env.TZ = zone;
    expect(payrollRunReadDate({ year: 2024, month: 2 })).toBe('2024-02-29');
    expect(payrollRunReadDate({ year: 2027, month: 2 })).toBe('2027-02-28');
    expect(payrollRunReadDate({ year: 2028, month: 2 })).toBe('2028-02-29');
    expect(payrollRunReadDate({ year: 2100, month: 2 })).toBe('2100-02-28');
    expect(payrollRunReadDate({ year: 2000, month: 2 })).toBe('2000-02-29');
  });

  it('getEmployeeComponents binds the read date it is given, unchanged, with the employee and company', async () => {
    process.env.TZ = zone;
    await getEmployeeComponents('e-1', 'c-1', '2026-03-31');
    await getEmployeeComponents('e-1', 'c-1', '2026-02-28');
    expect(bound).toEqual([
      ['e-1', 'c-1', '2026-03-31', '2026-03-31'],
      ['e-1', 'c-1', '2026-02-28', '2026-02-28'],
    ]);
  });
});
