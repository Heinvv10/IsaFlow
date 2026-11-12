/**
 * A stand-alone directive payment books its month's ETI (wave 5 ET; coordinator ruling H2 option a; Hein ruling R-A;
 * review round 2: the company lock first). ETI Act s9(1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const order: string[] = [];
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({ lockCompanyPayrollApprovals: vi.fn(async () => { order.push('lock'); }) }));
vi.mock('@/modules/accounting/services/payroll/etiPeriodGuard', () => ({ assertNoLaterEtiJournal: vi.fn(async () => { order.push('guard'); }) }));
vi.mock('@/modules/accounting/services/payroll/directiveEtiJournal', () => ({
  postMonthEtiJournal: vi.fn(async () => { order.push('eti'); return 'je-eti'; }),
}));
vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({
  rebookEtiAfterEvent: vi.fn(async () => { order.push('rebook'); return []; }),
}));
vi.mock('@/modules/accounting/services/payroll/taxDirectivePaymentService', () => ({
  applyTaxDirective: vi.fn(async () => { order.push('pay'); return { paymentId: 'p1', journalEntryId: 'je-d', gross: 4_500, paye: 1_500, net: 3_000, status: 'applied', advisories: [] }; }),
}));

import { assertNoLaterEtiJournal } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { postMonthEtiJournal } from '@/modules/accounting/services/payroll/directiveEtiJournal';
import { applyTaxDirective as applyPayment } from '@/modules/accounting/services/payroll/taxDirectivePaymentService';
import { applyTaxDirective } from '@/modules/accounting/services/payroll/directivePaymentEti';

const CO = '11111111-1111-1111-1111-111111111111';
beforeEach(() => { vi.clearAllMocks(); order.length = 0; });

describe('applyTaxDirective with ETI', () => {
  it('takes the company payroll lock, then the R-A guard, then pays, then books the month\'s ETI', async () => {
    const r = await applyTaxDirective(CO, 'd1', { paymentDate: '2026-05-20' }, 'u1');
    expect(order).toEqual(['lock', 'guard', 'pay', 'eti', 'rebook']);
    expect(r.etiJournalEntryId).toBe('je-eti');
    expect(assertNoLaterEtiJournal).toHaveBeenCalledWith(CO, { year: 2026, month: 5 });
    expect(postMonthEtiJournal).toHaveBeenCalledWith(CO, { year: 2026, month: 5 }, '2026-05-20', 'u1');
  });
  it('R-A: refused before the payment when a later month of the ETI period is in force', async () => {
    vi.mocked(assertNoLaterEtiJournal).mockRejectedValueOnce(new Error('The June 2026 payroll journal is in the ledger'));
    await expect(applyTaxDirective(CO, 'd1', { paymentDate: '2026-05-20' }, 'u1')).rejects.toThrow(/June 2026/);
    expect(applyPayment).not.toHaveBeenCalled();
    expect(postMonthEtiJournal).not.toHaveBeenCalled();
  });
});
