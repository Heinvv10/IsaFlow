/**
 * K-107 M1 — the retired 'recurring_invoice' (RINV) sequence must stop being
 * offered by the settings screen.
 *
 * Both recurring paths now mint from 'customer_invoice', so nothing reserves
 * from RINV any more. Left as it was, the company-settings document-number
 * editor still showed a RINV row with a prefix and a next-number the user could
 * edit — and editing it did nothing at all: a tenant that customised RINV to
 * match their stationery would still have got INV0000123. The row is filtered
 * on READ rather than deleted, because it carries the historical counter for
 * the RINV-<slug>-<YYYYMM> documents that already exist.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), { unsafe: vi.fn().mockReturnValue('') });
  return { sqlMock };
});

vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import {
  getDocumentNumbers,
  isRetiredDocumentNumberType,
} from '@/modules/accounting/services/core/companySettingsService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

const row = (documentType: string, prefix: string) => ({
  id: `id-${documentType}`,
  company_id: COMPANY_ID,
  document_type: documentType,
  prefix,
  next_number: 42,
  padding: 7,
});

describe('retired document number types', () => {
  beforeEach(() => sqlMock.mockReset());

  it('names recurring_invoice as retired and every live type as not', () => {
    expect.soft(isRetiredDocumentNumberType('recurring_invoice')).toBe(true);
    for (const live of ['customer_invoice', 'supplier_invoice', 'credit_note', 'quote']) {
      expect.soft(isRetiredDocumentNumberType(live)).toBe(false);
    }
    expect(isRetiredDocumentNumberType('')).toBe(false);
  });

  it('does not return the retired row to the settings screen, and returns the rest', async () => {
    sqlMock.mockResolvedValue([
      row('customer_invoice', 'INV'),
      row('recurring_invoice', 'RINV'),
      row('supplier_invoice', 'SIV'),
    ]);

    const result = await getDocumentNumbers(COMPANY_ID);
    expect.soft(result.map((d) => d.documentType)).toEqual(['customer_invoice', 'supplier_invoice']);
    // Filtered, not truncated: the surviving rows still map in full.
    expect(result[0]).toMatchObject({ prefix: 'INV', nextNumber: 42, padding: 7 });
  });

  it('leaves the historical counter row in place — it is hidden, not deleted', async () => {
    sqlMock.mockResolvedValue([row('recurring_invoice', 'RINV')]);

    await getDocumentNumbers(COMPANY_ID);
    const statements = sqlMock.mock.calls.map((args) => (args[0] as TemplateStringsArray).join(' '));
    expect.soft(statements.some((s) => s.includes('DELETE'))).toBe(false);
    expect(statements.every((s) => s.includes('SELECT'))).toBe(true);
  });
});
