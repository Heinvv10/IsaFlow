/**
 * Discounts and unread money fields (team-lead decision after round 12): a money field this import does not read would be dropped
 * silently, booking the PO at another figure (a 50% line discount booked at full price). So, failing closed, but only on a value that is
 * not zero (most exports carry Discount: 0):
 *   - a discount on a PO line (Discount, DiscountPercentage, DiscountAmount) or on the PO (Discount, DiscountPercentage), in any spelling
 *     (fieldKey), refuses the PO as `po_discount_unsupported`, naming the field and its value; on an item, `item_discount_unsupported`;
 *   - any other key that looks like money (amount, price, total, discount, rebate, surcharge, charge) on a PO or a line, outside the
 *     fields read, refuses the PO as `po_money_field_unsupported`;
 *   - a line's Total, now read, must be its Exclusive + Tax.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';
import { isZeroish } from '@/modules/accounting/services/sage-migration/sageMoneyFields';

const item = (extra: Record<string, unknown> = {}) => ({ ID: 50, Code: 'C50', Description: 'a', Active: true, Physical: true, ...extra });
const po = (line: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ ID: 1, DocumentNumber: 'P1', Date: '2026-02-01', Status: 'Pending', SupplierId: 3,
  Exclusive: 100, Tax: 15, Total: 115, Lines: [{ Description: 'x', Quantity: 1, UnitPriceExclusive: 100, TaxTypeId: 1, Exclusive: 100, Tax: 15, ...line }], ...extra });
const refused = (file: Record<string, unknown>) => {
  const p = parseSageExport(file);
  return { kept: p.purchaseOrders.length + p.items.length, codes: p.refusals.map((r) => r.code), why: p.refusals.flatMap((r) => r.reasons).join(' | ') };
};

describe('a discount that is not zero', () => {
  it('on a PO line, in any of its names and spellings, refuses the PO as po_discount_unsupported, naming the field and value', () => {
    for (const [key, value] of [['Discount', 10], ['DiscountPercentage', 50], ['DiscountAmount', '12.50'], ['discount_percentage', 5], ['DISCOUNT', 1]] as const) {
      const r = refused({ PurchaseOrders: [po({ [key]: value })] });
      expect(r.kept, key).toBe(0);
      expect(r.codes, key).toEqual(['po_discount_unsupported']);
      expect(r.why, key).toContain(`Lines[0].${key} is ${JSON.stringify(value)}: a discount is not imported`);
    }
  });
  it('on the PO itself refuses it; on an item refuses the item as item_discount_unsupported', () => {
    for (const key of ['Discount', 'DiscountPercentage']) {
      expect(refused({ PurchaseOrders: [po({}, { [key]: 20 })] }).codes, key).toEqual(['po_discount_unsupported']);
    }
    const i = refused({ Items: [item({ DiscountPercentage: 10 })] });
    expect(i).toMatchObject({ kept: 0, codes: ['item_discount_unsupported'] });
    expect(i.why).toContain('DiscountPercentage is 10: a discount is not imported');
  });
  it('zero, absent, null and blank pass (most exports carry Discount: 0)', () => {
    for (const value of [0, '0', '0.00', null, '', '  ', false]) {
      expect(refused({ Items: [item({ Discount: value })], PurchaseOrders: [po({ Discount: value, DiscountPercentage: value }, { Discount: value })] }), JSON.stringify(value)).toMatchObject({ kept: 2, codes: [] });
    }
  });
});

describe('another money-like field this import does not read', () => {
  it('not zero on a line or the PO refuses the PO as po_money_field_unsupported', () => {
    for (const [line, extra, key] of [
      [{ SurchargeAmount: 2 }, {}, 'Lines[0].SurchargeAmount'], [{ PriceInclusive: 115 }, {}, 'Lines[0].PriceInclusive'],
      [{}, { OutstandingAmount: 115 }, 'OutstandingAmount'], [{}, { DeliveryCharge: 30 }, 'DeliveryCharge'], [{}, { TotalInclusive: 'x' }, 'TotalInclusive'],
    ] as const) {
      const r = refused({ PurchaseOrders: [po(line, extra)] });
      expect(r.codes, key).toEqual(['po_money_field_unsupported']);
      expect(r.why, key).toContain(`${key} is `);
      // R1 (round 13): the refusal says what to do with a field the real export turns out to carry
      expect(r.why, key).toContain('add it, with its check, to the reviewed list in sageMoneyFields.ts');
    }
  });
  it('zero passes; the fields read (Exclusive, Tax, Total, UnitPriceExclusive) and non-money fields are not touched', () => {
    expect(refused({ PurchaseOrders: [po({ Rebate: 0 }, { OutstandingAmount: 0, Reference: 'R1', Comments: 'c' })] }).codes).toEqual([]);
  });
  it('the synthetic fixture reads clean (its line Total is Exclusive + Tax)', () => {
    expect(parseSageExport(JSON.parse(readFileSync('tests/fixtures/sage-export/sage-export.json', 'utf8'))).refusals).toEqual([]);
  });
});

describe('a line Total', () => {
  it('must be its Exclusive + Tax (a discount hidden in the Total is refused, not booked at the price)', () => {
    const r = refused({ PurchaseOrders: [po({ Total: 57.5 })] });
    expect(r.kept).toBe(0);
    expect(r.why).toContain('Lines[0].Total 57.5 is not Exclusive 100 + Tax 15');
    expect(refused({ PurchaseOrders: [po({ Total: 115 })] }).codes).toEqual([]);
  });
});

describe('R2 (round 13): discount spellings, by word inside the key', () => {
  it('Disc%, Markdown, Allowance, PercentOff, Rebate, LineDiscountAmount and an accented Discöunt on a line refuse as po_discount_unsupported', () => {
    for (const key of ['Disc%', 'MarkdownValue', 'Allowance', 'PercentOff', 'Rebate', 'LineDiscountAmount', 'Disc\u00f6unt', 'R\u00e9bate']) {
      const r = refused({ PurchaseOrders: [po({ [key]: 5 })] });
      expect(r.codes, key).toEqual(['po_discount_unsupported']);
      expect(r.why, key).toMatch(new RegExp(`Lines\\[0\\]\\.${key.replace(/[%]/g, '%')} is 5: (a discount is not imported|a field named like a discount)`));
    }
  });
  it('on an item, by word too (ItemDiscountPercent, TradeRebate), not only the exact key', () => {
    for (const key of ['ItemDiscountPercent', 'TradeRebate']) expect(refused({ Items: [item({ [key]: 10 })] }).codes, key).toEqual(['item_discount_unsupported']);
  });
  it('the description and other plain fields are not discounts', () => {
    expect(refused({ Items: [item({ Description: 'Disc brake' })], PurchaseOrders: [po({ Description: 'discount rack' })] }).codes).toEqual([]);
  });
});

describe('R15-L4 (round 15): zero as people write it, and the wording of a key only named like a discount', () => {
  it('"0%", "0,00", "0,0 %" are zero (no refusal); "5%", "0,01" are not', () => {
    expect(['0%', '0,00', '0,0 %', ' 0.00% '].map(isZeroish)).toEqual([true, true, true, true]);
    expect(['5%', '0,01', '%', ','].map(isZeroish)).toEqual([false, false, false, false]);
    expect(refused({ PurchaseOrders: [po({ DiscountPercentage: '0%', Discount: '0,00' })] }).codes).toEqual([]);
  });
  it('Discount / DiscountPercentage / DiscountAmount say "a discount is not imported"; a key only named like one says it is not read', () => {
    expect(refused({ PurchaseOrders: [po({ DiscountAmount: 3 })] }).why).toContain('Lines[0].DiscountAmount is 3: a discount is not imported');
    const r = refused({ Items: [item({ Discontinued: true })] });
    expect(r.codes).toEqual(['item_discount_unsupported']);
    expect(r.why).toContain('Discontinued is true: a field named like a discount (Discontinued) is not read; it is refused, never dropped');
    expect(r.why).not.toContain('undiscounted');
  });
});
