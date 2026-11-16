/**
 * Wave 6 PS3: which details a slip prints. The snapshot only when the line is frozen (judged in SQL: final, and the
 * snapshot's approvedAt is the header's current approved_at); otherwise the live row and the live employer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('no database in this test'); }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { detailsOf, type DetailsRow, type PayslipSnapshot } from '@/modules/accounting/services/payroll/payslipSnapshot';

const live = {
  employee_number: 'E-1', first_name: 'Live', last_name: 'Name', tax_number: '1', payment_method: 'eft', occupation: 'Now',
  pay_basis: 'monthly', hours_per_week: 40, hours_per_day: 8, hourly_rate: null, daily_rate: null,
  bank_last_four: '9999', bank_length: 11, bank_name: 'Capitec',
};
const snapshot: PayslipSnapshot = {
  ...live, first_name: 'Frozen', occupation: 'Then', bank_last_four: '1111', bank_name: 'FNB',
  approvedAt: '2026-11-16T10:00:00.123456+02:00', employer: { name: 'Then Ltd', address: '1 Old Road' },
  yearToDate: { grossPay: 60000, taxableIncome: 60000, paye: 9000, uifEmployee: 354.24, netPay: 50645.76 },
};
const liveEmployer = { name: 'Now Ltd', address: '9 New Street' };
const row = (frozen: boolean, snap: unknown = snapshot): DetailsRow => ({ ...live, payslip_snapshot: snap, details_frozen: frozen });

describe('detailsOf', () => {
  it('frozen: the snapshot and its employer', () => {
    const shown = detailsOf(row(true), liveEmployer);
    expect(shown.details).toMatchObject({ first_name: 'Frozen', occupation: 'Then', bank_last_four: '1111', bank_name: 'FNB' });
    expect(shown.employer).toEqual({ name: 'Then Ltd', address: '1 Old Road' });
    expect(shown.yearToDate?.grossPay).toBe(60000);
  });

  it('not frozen (another approval, or not final): live, even with a snapshot present', () => {
    const shown = detailsOf(row(false), liveEmployer);
    expect(shown.details).toMatchObject({ first_name: 'Live', occupation: 'Now', bank_last_four: '9999' });
    expect(shown.employer).toBe(liveEmployer);
    expect(shown.yearToDate).toBeNull();
  });

  it('frozen but no snapshot object: live', () => {
    expect(detailsOf(row(true, null), liveEmployer).details.first_name).toBe('Live');
    expect(detailsOf(row(true, 'garbage'), liveEmployer).employer).toBe(liveEmployer);
  });
});
