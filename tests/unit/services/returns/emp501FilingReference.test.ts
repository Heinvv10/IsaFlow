/**
 * Wave 6 EFb: an EMP501's reference is the e@syFile / eFiling submission reference, not a PRN. It carries no tax number,
 * so it is never judged against the company's PAYE reference (a reference that happens to start with 7 is not refused),
 * and it is still refused when another period's return already records it. Database mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql }));

import { assertFilingReferenceIsTheCompanys, parseFilingReference } from '@/modules/accounting/services/returns/filingReference';
import type { ReturnVersion } from '@/modules/accounting/services/returns/returnVersionTypes';

const EMP501 = { id: 'v1', formType: 'EMP501', periodStart: '2025-03-01', periodEnd: '2025-08-31' } as ReturnVersion;
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => { m.sql.mockReset(); });

describe('the EMP501 reference', () => {
  it('takes 6 to 30 letters and digits, upper-cased, spaces and dashes dropped', () => {
    expect(parseFilingReference('EMP501', 'abc-123 456')).toBe('ABC123456');
    expect(() => parseFilingReference('EMP501', 'AB12')).toThrow(/6 to 30 letters and digits/);
  });

  it('is not checked against the PAYE reference: only the reuse query runs, and a 7... reference passes', async () => {
    m.sql.mockResolvedValueOnce([]); // no other period's return has it
    expect(await refusal(assertFilingReferenceIsTheCompanys('c1', EMP501, '7999999999123'))).toBeNull();
    expect(m.sql).toHaveBeenCalledTimes(1);
    expect(m.sql.mock.calls[0]![0].join('')).toMatch(/FROM tax_return_versions/);
  });

  it('is refused (409) when another period\'s return already records it', async () => {
    m.sql.mockResolvedValueOnce([{ period_start: '2025-03-01', period_end: '2026-02-28' }]);
    expect(await refusal(assertFilingReferenceIsTheCompanys('c1', EMP501, 'SUB123456')))
      .toMatchObject({ status: 409, refusalCode: 'FILING_REFERENCE_REUSED' });
  });
});
