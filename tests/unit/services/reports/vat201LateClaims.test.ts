/** Wave 6 LC: the VAT201 late-claims section's assembly (pure). Figures are proven in tests/integration/vat201-late-claims-section.int.test.ts. */
import { describe, expect, it } from 'vitest';
import {
  Vat201LateClaimsMismatchError, buildLateClaimsSection, toLateClaimRow, type Vat201LateClaimRow,
} from '@/modules/accounting/services/reports/vat201LateClaims';

const row = (vat: number, over: Partial<Vat201LateClaimRow> = {}): Vat201LateClaimRow => ({
  journalEntryId: `j${vat}`, entryNumber: `JE-${vat}`, claimDate: '2026-11-01', kind: 'claim', original: null,
  document: null, filedPeriod: null, boxes: ['15'], vat, ...over,
});

describe('buildLateClaimsSection', () => {
  it('a claim and its reversal net: the total is their sum and must equal the boxes\' late part', () => {
    const s = buildLateClaimsSection('2026-11-01', '2026-12-31', [row(15000), row(3000), row(-3000, { kind: 'reversal' })], 15000);
    expect(s.total).toBe(15000);
    expect(s.lateClaimInputTax).toBe(15000);
    expect(s.rows).toHaveLength(3);
  });

  it('sums in cents: 0.10 + 0.20 is 0.30, not 0.30000000000000004', () => {
    expect(buildLateClaimsSection('a', 'b', [row(0.1), row(0.2)], 0.3).total).toBe(0.3);
  });

  it('throws when the rows and the boxes differ by one cent', () => {
    expect(() => buildLateClaimsSection('2026-11-01', '2026-12-31', [row(15000)], 15000.01))
      .toThrow(Vat201LateClaimsMismatchError);
    expect(() => buildLateClaimsSection('2026-11-01', '2026-12-31', [], 1)).toThrow(/R0\.00.*R1\.00/);
  });
});

describe('toLateClaimRow', () => {
  it('maps a reversal of a supplier-invoice claim, with its boxes, dates as days and VAT in cents', () => {
    const r = toLateClaimRow({
      id: 'rev', entry_number: 'JE-9', entry_date: new Date('2026-11-01T00:00:00Z'), is_reversal: true,
      original_id: 'orig', original_number: 'JE-1', original_date: '2026-10-12',
      invoice_id: 'si', invoice_number: 'INV-7', supplier_name: 'Acme',
      filed_start: new Date('2026-09-01T00:00:00Z'), filed_end: '2026-10-31',
      vat: '-1500.004', vat_types: ['standard', 'capital_goods', 'standard'],
    });
    expect(r).toEqual({
      journalEntryId: 'rev', entryNumber: 'JE-9', claimDate: '2026-11-01', kind: 'reversal',
      original: { journalEntryId: 'orig', entryNumber: 'JE-1', entryDate: '2026-10-12' },
      document: { supplierInvoiceId: 'si', invoiceNumber: 'INV-7', supplierName: 'Acme' },
      filedPeriod: { start: '2026-09-01', end: '2026-10-31' },
      boxes: ['14', '15'], vat: -1500,
    });
  });

  it('a manual-journal claim has no document; a missing original or lock is null, not invented', () => {
    const r = toLateClaimRow({ id: 'c', entry_number: 'JE-2', entry_date: '2026-11-01', is_reversal: false, vat: '150', vat_types: [null].map(() => 'standard') });
    expect(r).toMatchObject({ kind: 'claim', original: null, document: null, filedPeriod: null, boxes: ['15'], vat: 150 });
  });
});
