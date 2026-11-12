/**
 * The EMP201's unbooked-refund warning names the remedy that works (wave 5 ET, review round 5): "Book ETI for this
 * month" for a month with no pay run journal in force; reopen and approve for a month whose run journal is in force.
 * ETI Act s10(1).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/etiBooking', () => ({
  bookedByRunJournal: vi.fn(async () => ({ used: 0, refund: 0, net2140: 0 })),
  bookedByEtiJournals: vi.fn(async () => ({ used: 0, refund: 0 })),
}));
vi.mock('@/modules/accounting/services/payroll/etiRebook', () => ({ runJournalInForce: vi.fn(async () => false) }));

import { runJournalInForce } from '@/modules/accounting/services/payroll/etiRebook';
import { unbookedRefundWarnings } from '@/modules/accounting/services/payroll/etiRefundWarning';

const AUG = { year: 2026, month: 8, paye: 0, eti: 0, broughtForward: 900, available: 900, used: 0, carriedForward: 0, refundClaimable: 900 };
beforeEach(() => vi.clearAllMocks());

describe('unbookedRefundWarnings', () => {
  it('a run-less August: names "Book ETI for this month" on the August EMP201', async () => {
    const [w] = await unbookedRefundWarnings('co', [AUG], { year: 2026, month: 8 });
    expect(w).toContain('There is no August 2026 pay run journal: use "Book ETI for this month" on the August 2026 EMP201 to book it');
    expect(w).not.toContain('Post the August pay run');
  });
  it('an August whose run journal is in force: reopen and approve it again (the action cannot book a run month)', async () => {
    vi.mocked(runJournalInForce).mockResolvedValueOnce(true);
    const [w] = await unbookedRefundWarnings('co', [AUG], { year: 2026, month: 8 });
    expect(w).toContain('Reopen the August 2026 pay run and approve it again to book it.');
    expect(w).not.toContain('Book ETI for this month');
  });
});
