/** Integrity check paye_payable_differs_from_emp201 (wave 5 ET, Hein ruling R-A): the ledger's month 2140 vs the EMP201. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/emp201Service', () => ({ generateEMP201: vi.fn() }));

import { sql } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { payePayableDiffersFromEmp201 } from '@/modules/accounting/services/gl/integrityChecks/payrollChecks';
import { INTEGRITY_CHECK_IDS } from '@/modules/accounting/services/gl/integrityChecks';

const CTX = { companyId: '11111111-1111-1111-1111-111111111111', asAt: '2026-06-30', limit: 20 };

beforeEach(() => vi.clearAllMocks());

describe('paye_payable_differs_from_emp201', () => {
  it('is in the suite', () => {
    expect(INTEGRITY_CHECK_IDS).toContain('paye_payable_differs_from_emp201');
  });
  it('flags a month whose 2140 differs from the EMP201 payable, and passes one that agrees', async () => {
    vi.mocked(sql).mockResolvedValueOnce([
      { period_year: 2026, period_month: 5, ledger: 0, refund: 0 },
      { period_year: 2026, period_month: 6, ledger: 2_500, refund: 0 },
    ] as never);
    const carry = { broughtForward: 0, used: 0, carriedForward: 0, refundClaimable: 0 };
    vi.mocked(generateEMP201)
      .mockResolvedValueOnce({ payePayable: 0, etiCarry: carry } as never)
      .mockResolvedValueOnce({ payePayable: 700, etiCarry: carry } as never);
    const r = await payePayableDiffersFromEmp201(CTX);
    expect(r.count).toBe(1);
    expect(r.sample[0]).toMatchObject({ id: '2026-06', amount: 1_800 });
    expect(vi.mocked(generateEMP201).mock.calls[1]).toEqual([CTX.companyId, '2026-06-01', '2026-06-30']);
    const q = (vi.mocked(sql).mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(q).toContain("ga.account_code = '2140'");
    expect(q).toContain('jl.company_id = ?::UUID');
  });
  it('R-C: an August whose refund claimable was not booked (no journal to carry it) is reported', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ period_year: 2026, period_month: 8, ledger: 0, refund: 0 }] as never);
    vi.mocked(generateEMP201).mockResolvedValueOnce({ payePayable: 0, etiCarry: { broughtForward: 1_000, used: 0, carriedForward: 1_000, refundClaimable: 1_000 } } as never);
    const r = await payePayableDiffersFromEmp201({ ...CTX, asAt: '2026-08-31' });
    expect(r.sample).toEqual([expect.objectContaining({ id: '2026-08-refund', amount: -1_000 })]);
  });
});
