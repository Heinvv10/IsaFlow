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
/** Queries in order: the company's numbers; the per-company PRN lock; another period's version or submission with this PRN. */
const db = (company: Record<string, unknown>, reused: Record<string, unknown>[] = []) => {
  m.sql.mockReset();
  m.sql.mockResolvedValueOnce([company]).mockResolvedValueOnce([]).mockResolvedValueOnce(reused);
};
const sqlText = (i: number) => (m.sql.mock.calls[i]![0] as string[]).join('?');
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

beforeEach(() => vi.clearAllMocks());

describe('the PRN is the company\'s', () => {
  it('passes, with no warning, when the tax number matches or none is recorded', async () => {
    for (const vat of ['4123456789', '412 345 6789', '412-345-6789', null, '', '  ']) {
      db({ vat_number: vat, paye_reference_number: null });
      expect(await assertFilingReferenceIsTheCompanys('c1', VAT_VERSION, PRN), String(vat)).toBeNull();
    }
  });

  it('passes with the named warning PRN_NOT_CROSS_CHECKED when the recorded number is not a valid SARS number', async () => {
    for (const vat of ['N/A', '123', '7123456789', '41234567890', '412345678X']) {
      db({ vat_number: vat, paye_reference_number: null });
      expect(await assertFilingReferenceIsTheCompanys('c1', VAT_VERSION, PRN), vat).toEqual({
        code: 'PRN_NOT_CROSS_CHECKED',
        message: 'The company VAT number on file is not a valid SARS number; the PRN was not cross-checked.',
      });
    }
    db({ vat_number: null, paye_reference_number: '4123456789' }); // a VAT number in the PAYE field
    expect(await assertFilingReferenceIsTheCompanys('c1', EMP_VERSION, '7123456789L00000001'))
      .toMatchObject({ code: 'PRN_NOT_CROSS_CHECKED', message: expect.stringMatching(/PAYE reference on file/) });
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
    // L2: the per-company advisory lock is taken before the reuse is read, and legacy submissions are read too.
    expect(sqlText(1)).toMatch(/pg_advisory_xact_lock/);
    expect(sqlText(2)).toMatch(/FROM tax_return_versions[\s\S]*UNION ALL[\s\S]*FROM sars_submissions[\s\S]*submission_reference/);
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
