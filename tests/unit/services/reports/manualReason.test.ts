/** The manual elimination reason's limits (R15 quality L6): 4 missing, 5 enough, 500 allowed, 501 too long. */
import { describe, expect, it } from 'vitest';
import { MANUAL_REASON_MAX, MANUAL_REASON_MIN, manualReasonMissing, manualReasonTooLong, mirrorCoverage } from '@/modules/accounting/services/reports/manualReason';

describe('manualReason limits', () => {
  it('pins the limits', () => expect([MANUAL_REASON_MIN, MANUAL_REASON_MAX]).toEqual([5, 500]));
  it.each([[4, true], [5, false]])('%i characters where one is required: missing %s', (n, missing) => {
    expect(manualReasonMissing('x'.repeat(n), '2026-03-01') !== null).toBe(missing);
  });
  it.each([[500, false], [501, true]])('%i characters: too long %s', (n, long) => {
    expect(manualReasonTooLong('x'.repeat(n)) !== null).toBe(long);
  });
  it('names the cutover and the limit', () => {
    expect(manualReasonMissing('', '2026-03-01')).toMatch(/dated on or after 2026-03-01 needs a reason: give one \(at least 5 characters\)/);
    expect(manualReasonTooLong('x'.repeat(501))).toBe('The reason is too long: at most 500 characters');
  });
  it('R21 M2: says what mirroring covers (a pair, ZAR, approved, expense lines, one financial year, mapped accounts) and never that every document of the group is eliminated', () => {
    const t = mirrorCoverage('2026-03-01');
    expect(t).toContain('A company pair of this group mirrors its intercompany invoices and credit notes from 2026-03-01');
    for (const fact of ['ZAR', 'approved', 'expense lines', 'same financial year', 'mapped group accounts']) expect(t, fact).toContain(fact);
    expect(t).not.toMatch(/this group's intercompany (invoices|documents)[^.]* are eliminated by mirroring/);
    expect(manualReasonMissing('', '2026-03-01')).toContain(t);
  });
});
