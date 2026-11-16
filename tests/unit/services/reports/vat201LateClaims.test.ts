/** Wave 6 LC: the VAT201 late-claims section's assembly (pure). Figures are proven in tests/integration/vat201-late-claims-section.int.test.ts. */
import { describe, expect, it } from 'vitest';
import {
  Vat201LateClaimsMismatchError, buildLateClaimsSection, lateClaimLedgerRows, toLateClaimRow, type Vat201LateClaimRow,
} from '@/modules/accounting/services/reports/vat201LateClaims';
import { deriveVatBoxesWithLateClaims, type LateClaimAwareLine } from '@/modules/accounting/services/reports/vatLateClaimBasis';

const row = (vat: number, over: Partial<Vat201LateClaimRow> = {}): Vat201LateClaimRow => ({
  journalEntryId: `j${vat}`, entryNumber: `JE-${vat}`, claimDate: '2026-11-01', kind: 'claim', original: null,
  document: null, filedPeriod: null, reverses: null, boxes: ['15'], vat, ...over,
});

let n = 0;
const line = (je: string, over: Partial<LateClaimAwareLine>): LateClaimAwareLine => ({
  journalEntryId: je, entryNumber: `JE-${je}`, entryDate: '2026-11-01', lineId: `l${++n}`, accountId: 'a',
  accountCode: '1140', accountName: 'VAT Input', accountType: 'asset', accountSubtype: 'vat_input', vatType: 'standard',
  debit: 0, credit: 0, cancelledSource: false, entrySource: 'auto_vat_late_claim', lateClaimBase: null, reversalOfId: null, ...over,
});
const clearing = (je: string, credit: number, over: Partial<LateClaimAwareLine> = {}) => line(je, {
  accountCode: '1145', accountName: 'Input VAT - late claims', accountSubtype: 'vat_input_late_claim', vatType: null, credit, ...over,
});

describe('lateClaimLedgerRows: the rows come from the box snapshot, by the box rule', () => {
  const lines: LateClaimAwareLine[] = [
    // A claim with a standard and a capital-goods leg.
    line('c1', { debit: 1500, lateClaimBase: 10000 }), line('c1', { debit: 0.1, vatType: 'capital_goods', lateClaimBase: 0.67 }),
    clearing('c1', 1500.1),
    // Its reversal: copies the source, opposite sign.
    line('r1', { credit: 1500, lateClaimBase: -10000, reversalOfId: 'c1' }), clearing('r1', 0, { debit: 1500, reversalOfId: 'c1' }),
    // A companion-sourced journal with an OUTPUT leg is ordinary, never a late claim.
    line('o1', { debit: 300 }), line('o1', { accountSubtype: 'vat_output', accountName: 'VAT Output', credit: 300 }),
    // An ordinary journal with input tax.
    line('x1', { entrySource: 'manual', debit: 999 }),
    // A cancelled-source companion leg is not tax.
    line('k1', { debit: 50, cancelledSource: true }),
  ];

  it('lists each late-claim journal with its input tax, the reversal negative, and nothing else', () => {
    expect(lateClaimLedgerRows(lines)).toEqual([
      { journalEntryId: 'c1', entryNumber: 'JE-c1', entryDate: '2026-11-01', reversalOfId: null, vat: 1500.1, vatTypes: ['standard', 'capital_goods'] },
      { journalEntryId: 'r1', entryNumber: 'JE-r1', entryDate: '2026-11-01', reversalOfId: 'c1', vat: -1500, vatTypes: ['standard'] },
    ]);
  });

  it('its total is the box derivation\'s lateClaimInputTax for the same lines, to the cent', () => {
    const total = lateClaimLedgerRows(lines).reduce((s, r) => s + Math.round(r.vat * 100), 0) / 100;
    expect(total).toBe(deriveVatBoxesWithLateClaims(lines).lateClaimInputTax);
  });
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

  it('throws when the rows and the boxes differ by one cent; the message is the period and the totals only', () => {
    const rows = [row(15000, { journalEntryId: '11111111-2222-4333-8444-555555555555' })];
    let err: unknown;
    try { buildLateClaimsSection('2026-11-01', '2026-12-31', rows, 15000.01); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Vat201LateClaimsMismatchError);
    expect((err as Error).message).toBe(
      'VAT201 2026-11-01 to 2026-12-31: the late claims listed total R\u00A015\u00A0000.00, but the input-tax boxes carry R\u00A015\u00A0000.01 of late claims.');
    expect((err as Error).message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|SELECT|gl_journal/i);
  });
});

describe('toLateClaimRow', () => {
  const ledger = { journalEntryId: 'rev', entryNumber: 'JE-9', entryDate: '2026-11-01', reversalOfId: 'c', vat: -1500, vatTypes: ['standard', 'capital_goods'] };

  it('maps a reversal of a supplier-invoice claim: the claim it reverses, its date and the return it was filed in', () => {
    const r = toLateClaimRow(ledger, {
      id: 'rev', original_id: 'orig', original_number: 'JE-1', original_date: '2026-06-12',
      invoice_id: 'si', invoice_number: 'INV-7', supplier_name: 'Acme',
      filed_start: new Date('2026-05-01T00:00:00Z'), filed_end: '2026-06-30',
      reversed_id: 'c', reversed_number: 'JE-2', reversed_date: new Date('2026-07-01T00:00:00Z'),
      reversed_filed_start: '2026-07-01', reversed_filed_end: '2026-08-31',
    });
    expect(r).toEqual({
      journalEntryId: 'rev', entryNumber: 'JE-9', claimDate: '2026-11-01', kind: 'reversal',
      original: { journalEntryId: 'orig', entryNumber: 'JE-1', entryDate: '2026-06-12' },
      document: { supplierInvoiceId: 'si', invoiceNumber: 'INV-7', supplierName: 'Acme' },
      filedPeriod: { start: '2026-05-01', end: '2026-06-30' },
      reverses: { journalEntryId: 'c', entryNumber: 'JE-2', claimDate: '2026-07-01', filedIn: { start: '2026-07-01', end: '2026-08-31' } },
      boxes: ['14', '15'], vat: -1500,
    });
  });

  it('a reversal of an unfiled claim says so; a claim reverses nothing; missing metadata is null, not invented', () => {
    expect(toLateClaimRow(ledger, { reversed_id: 'c', reversed_number: 'JE-2', reversed_date: '2026-11-01' }).reverses)
      .toEqual({ journalEntryId: 'c', entryNumber: 'JE-2', claimDate: '2026-11-01', filedIn: null });
    const claim = toLateClaimRow({ ...ledger, reversalOfId: null, vat: 150, vatTypes: ['standard'] }, undefined);
    expect(claim).toMatchObject({ kind: 'claim', original: null, document: null, filedPeriod: null, reverses: null, boxes: ['15'], vat: 150 });
  });
});
