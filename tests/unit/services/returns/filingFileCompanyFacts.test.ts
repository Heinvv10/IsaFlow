/**
 * Wave 6 EFa round 1, with the database mocked: the PRN must carry the company's own tax number when a well-formed one
 * is recorded, one PRN names one period's return, and stampFilingFile throws unless it stamped exactly one row (EFb
 * relies on it). The real-PostgreSQL proofs are in tests/integration/w6-efa-filing-file-vat.int.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sql: vi.fn(), logAuditOrThrow: vi.fn() }));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: m.logAuditOrThrow }));
vi.mock('@/lib/auth/impersonationGuard', () => ({ assertNotImpersonating: vi.fn() }));

import { assertFilingReferenceIsTheCompanys } from '@/modules/accounting/services/returns/filingReference';
import { stampFilingFile } from '@/modules/accounting/services/returns/filingFileService';
import { EMP_VERSION, VAT_VERSION } from './filingFileSeed';

const PRN = '4123456789V00000001';
/** First query: the company's numbers; second: another period's version with this PRN. */
const db = (company: Record<string, unknown>, reused: Record<string, unknown>[] = []) => {
  m.sql.mockReset();
  m.sql.mockResolvedValueOnce([company]).mockResolvedValueOnce(reused);
};
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => vi.clearAllMocks());

describe('the PRN is the company\'s', () => {
  it('passes when the tax number matches, or when none (or a malformed one) is recorded', async () => {
    for (const vat of ['4123456789', '412 345 6789', null, '', 'N/A', '123', '7123456789']) {
      db({ vat_number: vat, paye_reference_number: null });
      expect(await refusal(assertFilingReferenceIsTheCompanys('c1', VAT_VERSION, PRN)), String(vat)).toBeNull();
    }
  });

  it('refuses a PRN of another VAT number (400) and of another PAYE reference on an EMP201', async () => {
    db({ vat_number: '4999999999', paye_reference_number: null });
    expect(await refusal(assertFilingReferenceIsTheCompanys('c1', VAT_VERSION, PRN)))
      .toMatchObject({ status: 400, refusalCode: 'FILING_REFERENCE_TAX_NUMBER' });
    db({ vat_number: '4123456789', paye_reference_number: '7000000001' });
    expect(await refusal(assertFilingReferenceIsTheCompanys('c1', EMP_VERSION, '7123456789L00000001')))
      .toMatchObject({ status: 400, refusalCode: 'FILING_REFERENCE_TAX_NUMBER' });
  });

  it('refuses a PRN already recorded on another period\'s return (409), naming that period', async () => {
    db({ vat_number: null }, [{ period_start: '2026-02-01', period_end: '2026-03-31' }]);
    expect(await refusal(assertFilingReferenceIsTheCompanys('c1', VAT_VERSION, PRN)))
      .toMatchObject({ status: 409, refusalCode: 'FILING_REFERENCE_REUSED', message: expect.stringMatching(/2026-02-01 to 2026-03-31/) });
  });
});

describe('stampFilingFile', () => {
  it('stores the content with its sha256 and audits it when one row was stamped', async () => {
    m.sql.mockReset();
    m.sql.mockResolvedValueOnce([{ id: VAT_VERSION.id }]);
    const sha = await stampFilingFile('c1', VAT_VERSION, 'a,b\r\n', 'vat201_capture_csv@1', 'csv', 'u1');
    expect(sha).toBe('fbf6b30113a4b6418c623a96ed6844f17ef5751b908a16abaa919d0bcd6b7784'); // sha256sum of the same bytes
    expect(m.sql.mock.calls[0]!.slice(1)).toEqual(expect.arrayContaining(['a,b\r\n', sha, 'vat201_capture_csv@1']));
    expect(m.logAuditOrThrow).toHaveBeenCalledTimes(1);
  });

  it.each([[0], [2]])('throws, and audits nothing, when %i rows were stamped', async (n) => {
    m.sql.mockReset();
    m.sql.mockResolvedValueOnce(Array.from({ length: n }, () => ({ id: 'x' })));
    await expect(stampFilingFile('c1', VAT_VERSION, 'a,b\r\n', 'vat201_capture_csv@1', 'csv', 'u1')).rejects.toThrow(/stamped \d rows/);
    expect(m.logAuditOrThrow).not.toHaveBeenCalled();
  });
});
