/**
 * Edit dates, a recurring row gaining more than one paid month: the note and remedy do not describe only the first
 * month's run (one may be an approved run, another a reopened run whose journal still stands).
 */
import { describe, expect, it } from 'vitest';
import type { TxSql } from '@/lib/neon';
import { refuseRecurringInPaidMonth } from '@/modules/accounting/services/payroll/payrollOnceOffGuard';

const tx = {} as TxSql; // the paid months are passed in: the guard reads nothing
const before = { from: '2026-03-01', to: '2026-04-30' };
const message = (after: { from: string; to: string | null }, paid: Array<{ year: number; month: number; reopened?: boolean }>) =>
  refuseRecurringInPaidMonth(tx, 'c', before, after, paid).then(() => null, (e) => (e as Error).message);

describe('gained paid months', () => {
  it('one approved and one reopened-with-journal-in-force month: neutral wording that fits both', async () => {
    const text = await message({ from: '2026-02-01', to: '2026-06-30' }, [{ year: 2026, month: 2 }, { year: 2026, month: 6, reopened: true }]);
    expect(text).toBe(
      '2026-02 and 2026-06 are already paid: a recurring row dated in them would never be paid for those months. Keep the row out of 2026-02 and 2026-06; '
      + 'or undo those runs first (reopen an approved run and reverse its journal; for a reopened run, reverse its journal), or capture the correction in an open period.');
    expect(text).not.toMatch(/\(approved run\)|\(reopened/);
  });

  it('a single gained month keeps its own note and remedy', async () => {
    expect(await message({ from: '2026-02-01', to: '2026-04-30' }, [{ year: 2026, month: 2 }])).toMatch(
      /^2026-02 is already paid \(approved run\).*Keep the row out of 2026-02; or reopen that run and reverse its journal first, or capture/);
    expect(await message({ from: '2026-02-01', to: '2026-04-30' }, [{ year: 2026, month: 2, reopened: true }])).toMatch(
      /^2026-02 is already paid \(reopened, but its journal is still posted\).*or reverse its journal first, or capture/);
  });
});
