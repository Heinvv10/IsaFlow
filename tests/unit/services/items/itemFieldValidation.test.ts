/**
 * Field validation shared by bulk_upsert_items and update_item (itemFieldValidation.ts): pure, so every refusal
 * lands before the first read. An unknown key is refused (a typo must not be ignored and reported as done), money is
 * exact whole cents, a service-looking input is not decided here (the planner does that against stored state).
 */
import { describe, expect, it } from 'vitest';
import { validateItemFields } from '@/modules/accounting/services/items/itemFieldValidation';

const A1 = '11111111-1111-4111-8111-111111111111';

const refused = (row: Record<string, unknown>) => {
  const r = validateItemFields(row);
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r.fields)}`);
  return r;
};

describe('validateItemFields', () => {
  it('maps the wire names to fields and lower-cases the external system', () => {
    const r = validateItemFields({
      code: ' FIB-001 ', description: 'Fibre 1km', item_type: 'physical', unit: 'm', purchase_price: 10.5, sales_price: '12.25',
      vat_on_sales: 'zero', vat_on_purchases: 'exempt', sales_account_id: A1, purchases_account_id: A1, inventory_tracked: true,
      is_active: false, notes: 'n', external_system: 'SAGE', external_ref: '42', external_document_number: 'ITM-42',
    });
    expect(r).toEqual({
      ok: true,
      fields: {
        code: 'FIB-001', description: 'Fibre 1km', itemType: 'physical', unit: 'm', purchasePrice: 10.5, salesPrice: 12.25,
        vatOnSales: 'zero', vatOnPurchases: 'exempt', salesAccountId: A1, purchasesAccountId: A1, inventoryTracked: true,
        isActive: false, notes: 'n', externalSystem: 'sage', externalRef: '42', externalDocumentNumber: 'ITM-42',
      },
    });
  });

  it('refuses an unknown key by name', () => {
    expect(refused({ code: 'X', sales_price_excl: 1 })).toMatchObject({ code: 'unknown_field' });
    expect(refused({ code: 'X', company_id: A1 })).toMatchObject({ code: 'unknown_field' });
  });

  it('refuses prices that are negative, not whole cents, not finite or not a number', () => {
    for (const bad of [-1, 1.005, Number.NaN, Infinity, '1.234', 'abc', null, true, 1e13]) {
      expect(refused({ code: 'X', purchase_price: bad }), String(bad)).toMatchObject({ code: 'invalid_field' });
    }
    expect(validateItemFields({ code: 'X', sales_price: 0 })).toMatchObject({ ok: true });
  });

  it('refuses a type or VAT type outside the vocabulary, and non-boolean flags', () => {
    expect(refused({ code: 'X', item_type: 'asset' })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', vat_on_sales: 'reduced' })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', inventory_tracked: 'yes' })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', is_active: 1 })).toMatchObject({ code: 'invalid_field' });
  });

  it('refuses malformed ids, over-long text and empty text', () => {
    expect(refused({ code: 'X', category_id: 'nope' })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', sales_account_id: 12 })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X'.repeat(51) })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', description: '   ' })).toMatchObject({ code: 'invalid_field' });
    expect(refused({ code: 'X', description: 'd'.repeat(256) })).toMatchObject({ code: 'invalid_field' });
  });

  it('needs an external_system with an external_ref', () => {
    expect(refused({ code: 'X', external_ref: '42' })).toMatchObject({ code: 'invalid_field' });
    expect(validateItemFields({ code: 'X', external_system: 'sage' })).toMatchObject({ ok: true });
  });

  it('takes the category by exactly one of id, code or name', () => {
    expect(refused({ code: 'X', category_id: A1, category_code: 'optics' })).toMatchObject({ code: 'invalid_field' });
    expect(validateItemFields({ code: 'X', category_code: 'optics' })).toMatchObject({ ok: true, fields: { categoryCode: 'optics' } });
  });
});
