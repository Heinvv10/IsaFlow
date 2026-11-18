/**
 * DBF readiness (coordinator ruling on #1571): a para 12D(6) member with 4001 / 4003 contributions is an IRP5 readiness
 * ERROR naming the employee, citing BRS V25.3.0 p. 54 ("4001 must be zero" when 4585 > 0 and 4472 = 0), marked UNVERIFIED.
 * The query side (final lines of the tax year carrying DB_FUND_RETIRED_MEMBER_4001) is proven in w6-db-fund.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { retiredMember4001Message, RETIRED_MEMBER_4001 } from '@/modules/accounting/services/payroll/definedBenefitReadiness';

describe('retiredMember4001Message', () => {
  it('is an error naming the employee, BRS p. 54 and UNVERIFIED; keyed on the calculate warning\'s code', () => {
    const m = retiredMember4001Message('Wanda Test');
    expect([m.severity, m.code, m.field]).toEqual(['error', 'IRP5_DB_RETIRED_MEMBER_4001', '4001']);
    expect(m.message).toMatch(/^Wanda Test: a retired defined-benefit fund member .*BRS V25\.3\.0 p\. 54: "4001 must be zero".*UNVERIFIED\.$/);
    expect(RETIRED_MEMBER_4001).toBe('DB_FUND_RETIRED_MEMBER_4001');
  });
});
