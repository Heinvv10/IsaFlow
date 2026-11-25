/**
 * Round-15 review R15-L5: the summary's "N items carried a QuantityOnHand, ignored" counts EVERY item row carrying the key, a refused row
 * and a quantity given as text included (it is never imported either way: the HARD RULE).
 */
import { describe, expect, it } from 'vitest';
import { parseSageExport } from '@/modules/accounting/services/sage-migration/sageExportParser';

const item = (id: number, extra: Record<string, unknown> = {}) => ({ ID: id, Code: `C${id}`, Description: 'a', Active: true, Physical: true, ...extra });

describe('itemsWithQuantityOnHand', () => {
  it('counts a refused row and a text quantity; not a row without the key or with it null', () => {
    const p = parseSageExport({ Items: [
      item(1, { QuantityOnHand: 5 }), item(2, { QuantityOnHand: '7' }), item(3, { QuantityOnHand: 2, Active: 'yes' }), item(4), item(5, { QuantityOnHand: null }),
    ] });
    expect(p.refusals.map((r) => r.sageId)).toEqual(['3']);
    expect(p.itemsWithQuantityOnHand).toBe(3);
  });
  it('R16-F4: a respelled key counts too (the row is refused for the spelling)', () => {
    const p = parseSageExport({ Items: [item(1, { quantityOnHand: 3 }), item(2, { 'Quantity_On_Hand': 4 }), item(3)] });
    expect(p.refusals.map((r) => r.sageId)).toEqual(['1', '2']);
    expect(p.itemsWithQuantityOnHand).toBe(2);
  });
});
