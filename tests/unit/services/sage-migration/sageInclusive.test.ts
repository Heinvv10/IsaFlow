/**
 * Round-14 breaker B14-1: a VAT-inclusive Sage PO was booked at line figures Sage does not show (the tool takes each line's tax the
 * exclusive way, round(net x 15%); Sage takes it out of the gross; one cent each way cancels in the header), exit 0. Refused, not guessed:
 *   - the header's `Inclusive` is read (a boolean); when true, every line must give its own Exclusive AND Tax (the tool then books them);
 *   - a line's UnitPriceInclusive with no line Tax must be what the tool books: net + tax = cents(Quantity x UnitPriceInclusive).
 * Also R14-L3 (AmountDue is checked only on an open PO) and R14-L5 (negative ids, "-0").
 * Pairs from the breaker's b14-money.ts: Sage line A 0.90 + 0.13 = 1.03, line B 1.03 + 0.16 = 1.19, PO 1.93 + 0.29 = 2.22.
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { mapSagePurchaseOrder } from '@/modules/accounting/services/sage-migration/sagePurchaseOrderMapping';
import { parsePurchaseOrder } from '@/lib/mcp/tools/purchaseOrderImportArgs';
import { isZeroish } from '@/modules/accounting/services/sage-migration/sageMoneyFields';

type R = Record<string, unknown>;
const po = (lines: R[], hdr: R = {}) => ({ ID: 7, DocumentNumber: 'P7', Date: '2026-02-01', Status: 'Pending', SupplierId: 3, Exclusive: 1.93, Tax: 0.29, Total: 2.22, Lines: lines, ...hdr });
const L = (x: R = {}): R => ({ Description: 'x', Quantity: 1, TaxTypeId: 1, ...x });
const A = { UnitPriceExclusive: 0.895652, UnitPriceInclusive: 1.03 };
const B = { UnitPriceExclusive: 1.034783, UnitPriceInclusive: 1.19 };
const read = (row: R) => {
  const p = parseSageExport({ PurchaseOrders: [row] });
  return { ok: p.purchaseOrders.length === 1, codes: p.refusals.map((r) => r.code), why: p.refusals.flatMap((r) => r.reasons).join(' | '), parsed: p };
};
const booked = (row: R) => {
  const t = parsePurchaseOrder(mapSagePurchaseOrder(read(row).parsed.purchaseOrders[0]!, '00000000-0000-4000-8000-000000000001', {}), 0);
  if (typeof t === 'string') throw new Error(t);
  return t.lines.map((l) => `${l.cents.net / 100}+${l.cents.tax / 100}`);
};

describe('B14-1: an Inclusive PO', () => {
  it('lines without their own Exclusive and Tax are refused (INCL-1, INCL-5), never booked a cent off each way', () => {
    for (const lines of [[L(A), L(B)], [L({ ...A, Exclusive: 0.9 }), L({ ...B, Exclusive: 1.03 })]]) {
      const r = read(po(lines, { Inclusive: true }));
      expect(r.ok).toBe(false);
      expect(r.why).toContain('Lines[0] of a VAT-inclusive PO (Inclusive true) must give its own Exclusive and Tax');
    }
  });
  it('lines that give Exclusive and Tax are booked at exactly those figures (INCL-2)', () => {
    const row = po([L({ ...A, Exclusive: 0.9, Tax: 0.13, Total: 1.03 }), L({ ...B, Exclusive: 1.03, Tax: 0.16, Total: 1.19 })], { Inclusive: true });
    expect(read(row).ok).toBe(true);
    expect(booked(row)).toEqual(['0.9+0.13', '1.03+0.16']);
  });
  it('Inclusive false or absent reads as before; anything but a boolean is refused', () => {
    expect(read(po([L({ UnitPriceExclusive: 100 })], { Inclusive: false, Exclusive: 100, Tax: 15, Total: 115 })).ok).toBe(true);
    expect(read(po([L({ UnitPriceExclusive: 100 })], { Inclusive: 'yes', Exclusive: 100, Tax: 15, Total: 115 })).why).toContain('Inclusive must be true or false');
  });
});

describe('B14-1: UnitPriceInclusive on a line with no Tax', () => {
  it('must be what the tool books: no Inclusive flag at all (INCL-4) is refused, a cent off each way', () => {
    const r = read(po([L(A), L(B)]));
    expect(r.ok).toBe(false);
    expect(r.why).toContain('Lines[0] would be booked at 1.04 (0.9 + 0.14), but Quantity 1 x UnitPriceInclusive 1.03 is 1.03');
  });
  it('agrees: passes', () => {
    expect(read(po([L({ UnitPriceExclusive: 100, UnitPriceInclusive: 115 })], { Exclusive: 100, Tax: 15, Total: 115 })).ok).toBe(true);
  });
});

describe('R14-L3: AmountDue is checked on an open PO only', () => {
  it('an Invoiced or Cancelled PO with AmountDue 0 passes; an open one is refused', () => {
    const hdr = (Status: string) => ({ Status, Exclusive: 100, Tax: 15, Total: 115, AmountDue: 0 });
    const line = [L({ UnitPriceExclusive: 100 })];
    expect(read(po(line, hdr('Invoiced'))).ok).toBe(true);
    expect(read(po(line, hdr('Cancelled'))).ok).toBe(true);
    expect(read(po(line, hdr('Pending'))).codes).toEqual(['po_money_field_unsupported']);
  });
});

describe('R14-L5', () => {
  it('a negative id is refused (a -1 SupplierId would go to the by-name lookup)', () => {
    expect(read(po([L({ UnitPriceExclusive: 100 })], { SupplierId: -1, Exclusive: 100, Tax: 15, Total: 115 })).why).toContain('SupplierId must be a Sage numeric id (negative)');
    expect(read(po([L({ UnitPriceExclusive: 100, ItemId: '-50' })], { Exclusive: 100, Tax: 15, Total: 115 })).why).toContain('Lines[0].ItemId must be a Sage numeric id (negative)');
  });
  it('isZeroish: "-0" and "-0.00" are zero; "-0.01" is not', () => {
    expect(['-0', '-0.00', '+0', ' 0.0 ', -0].map(isZeroish)).toEqual([true, true, true, true, true]);
    expect(['-0.01', '0.1', '-1'].map(isZeroish)).toEqual([false, false, false]);
  });
});

describe('R15-M1 (round 15): the per-unit UnitPriceInclusive check allows 1 cent; the line gross stays exact', () => {
  const line = (x: R) => po([L({ UnitPriceExclusive: 8.7, TaxTypeId: 1, ...x })], { Exclusive: 8.7, Tax: 1.3, Total: 10 });
  it('8.70 ex VAT at 15% is 10.005: a Sage UnitPriceInclusive of 10.00 (with the line\'s own Tax) passes; 2 cents off does not', () => {
    expect(read(line({ Exclusive: 8.7, Tax: 1.3, Total: 10, UnitPriceInclusive: 10 })).ok).toBe(true);
    expect(read(line({ Exclusive: 8.7, Tax: 1.3, Total: 10, UnitPriceInclusive: 9.99 })).why).toContain('UnitPriceInclusive 9.99 is not UnitPriceExclusive 8.7 at 15% (10.01)');
  });
  it('without the line Tax, the booked gross must be Quantity x UnitPriceInclusive to the cent', () => {
    expect(read(line({ UnitPriceInclusive: 10 })).why).toContain('Lines[0] would be booked at 10.01 (8.7 + 1.31), but Quantity 1 x UnitPriceInclusive 10 is 10');
  });
  it('R15-L2: the gross is Quantity x UnitPriceInclusive (2 x 115 = 230 agrees; it is not one unit)', () => {
    expect(read(po([L({ Quantity: 2, UnitPriceExclusive: 100, UnitPriceInclusive: 115 })], { Exclusive: 200, Tax: 30, Total: 230 })).ok).toBe(true);
  });
});
