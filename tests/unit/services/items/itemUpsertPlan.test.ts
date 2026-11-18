/**
 * The decision half of bulk_upsert_items / update_item (itemUpsertPlan.ts), pure: created / updated / unchanged per
 * row, every refusal with its index and code, and the matching rule (external reference first, then code; a row whose
 * reference and code hit two different items is refused). The same function runs for a dry run and a live call.
 */
import { describe, expect, it } from 'vitest';
import { planItemRows } from '@/modules/accounting/services/items/itemUpsertPlan';
import { refKey, type ExistingItem, type UpsertContext } from '@/modules/accounting/services/items/itemUpsertContext';
import { validateItemFields, type ItemFields } from '@/modules/accounting/services/items/itemFieldValidation';

const ACC = '11111111-1111-4111-8111-111111111111';
const INACTIVE_ACC = '22222222-2222-4222-8222-222222222222';
const CAT_OPTICS = '33333333-3333-4333-8333-333333333333';
const CAT_OLD = '44444444-4444-4444-8444-444444444444';

const stored = (over: Partial<ExistingItem> & Pick<ExistingItem, 'id' | 'code'>): ExistingItem => ({
  deleted: false, description: 'Fibre 1km', itemType: 'physical', unit: 'each', categoryId: null, purchasePrice: 10, salesPrice: 15,
  vatOnSales: 'standard', vatOnPurchases: 'standard', salesAccountId: null, purchasesAccountId: null, inventoryTracked: false,
  isActive: true, notes: null, externalSystem: null, externalRef: null, externalDocumentNumber: null, ...over,
});

function ctxOf(items: ExistingItem[], movements: string[] = []): UpsertContext {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byCode = new Map(items.map((i) => [i.code, i]));
  const byRef = new Map(items.filter((i) => i.externalSystem && i.externalRef).map((i) => [refKey(i.externalSystem!, i.externalRef!), i]));
  return {
    byId, byCode, byRef,
    categories: [
      { id: CAT_OPTICS, code: 'optics', name: 'Optics', isActive: true },
      { id: CAT_OLD, code: 'old', name: 'Old', isActive: false },
    ],
    accounts: new Map([[ACC, true], [INACTIVE_ACC, false]]),
    itemsWithMovements: new Set(movements),
  };
}

const row = (index: number, raw: Record<string, unknown>, targetId?: string) => {
  const c = validateItemFields(raw);
  if (!c.ok) throw new Error(c.reason);
  return { index, fields: c.fields as ItemFields, targetId };
};

describe('planItemRows — outcomes', () => {
  it('creates a new item with the defaults, naming every field it was given', () => {
    const { planned, refusals } = planItemRows([row(0, { code: 'N1', description: 'New', sales_price: 9.5 })], ctxOf([]));
    expect(refusals).toEqual([]);
    expect(planned[0]).toMatchObject({ outcome: 'created', itemId: null, code: 'N1', changed: ['code', 'description', 'sales_price'] });
    expect(planned[0]!.values).toMatchObject({
      item_type: 'physical', unit: 'each', vat_on_sales: 'standard', vat_on_purchases: 'standard', cost_price: 0,
      selling_price_excl: 9.5, inventory_tracked: false, is_active: true,
    });
  });

  it('reports a row whose named fields all equal the stored ones as unchanged, and an omitted field is kept', () => {
    const a = stored({ id: 'a', code: 'A', salesPrice: 15, externalSystem: 'sage', externalRef: '1' });
    const { planned } = planItemRows([row(0, { code: 'A', description: 'Fibre 1km', sales_price: '15.00', external_system: 'sage', external_ref: '1' })], ctxOf([a]));
    expect(planned[0]).toMatchObject({ outcome: 'unchanged', itemId: 'a', changed: [] });
    expect(planned[0]!.values).toEqual({});
  });

  it('updates only the fields that differ', () => {
    const a = stored({ id: 'a', code: 'A' });
    const { planned } = planItemRows([row(0, { code: 'A', description: 'Fibre 2km', purchase_price: 10, sales_price: 16 })], ctxOf([a]));
    expect(planned[0]).toMatchObject({ outcome: 'updated', itemId: 'a', changed: ['description', 'sales_price'] });
    expect(planned[0]!.values).toEqual({ description: 'Fibre 2km', selling_price_excl: 16 });
  });

  it('matches by external reference first: the reference finds the item whose code has since changed', () => {
    const a = stored({ id: 'a', code: 'OLD', externalSystem: 'sage', externalRef: '7' });
    const { planned, refusals } = planItemRows([row(0, { code: 'NEW', external_system: 'sage', external_ref: '7' })], ctxOf([a]));
    expect(refusals).toEqual([]);
    expect(planned[0]).toMatchObject({ outcome: 'updated', itemId: 'a', code: 'NEW', changed: ['code'] });
  });

  it('attaches a reference to an item matched by code that has none', () => {
    const a = stored({ id: 'a', code: 'A' });
    const { planned } = planItemRows([row(0, { code: 'A', external_system: 'sage', external_ref: '9' })], ctxOf([a]));
    expect(planned[0]).toMatchObject({ outcome: 'updated', changed: ['external_system', 'external_ref'] });
  });

  it('resolves a category by id, code or name, case-insensitively for the name', () => {
    const ctx = ctxOf([]);
    for (const raw of [{ category_id: CAT_OPTICS }, { category_code: 'optics' }, { category_name: 'OPTICS' }]) {
      const { planned, refusals } = planItemRows([row(0, { code: 'N', description: 'd', ...raw })], ctx);
      expect(refusals).toEqual([]);
      expect(planned[0]!.values.category_id).toBe(CAT_OPTICS);
    }
  });
});

describe('planItemRows — refusals (each with the row index and a code)', () => {
  const codes = (rows: ReturnType<typeof row>[], ctx: UpsertContext) => planItemRows(rows, ctx).refusals.map((r) => `${r.index}:${r.code}`);

  it('refuses a row whose reference and code belong to two DIFFERENT items', () => {
    const ctx = ctxOf([stored({ id: 'a', code: 'A', externalSystem: 'sage', externalRef: '1' }), stored({ id: 'b', code: 'B', externalSystem: 'sage', externalRef: '2' })]);
    expect(codes([row(3, { code: 'B', external_system: 'sage', external_ref: '1' })], ctx)).toEqual(['3:ref_code_conflict']);
  });

  it('refuses a code that already carries a different reference', () => {
    const ctx = ctxOf([stored({ id: 'b', code: 'B', externalSystem: 'sage', externalRef: '2' })]);
    expect(codes([row(0, { code: 'B', external_system: 'sage', external_ref: '99' })], ctx)).toEqual(['0:code_in_use_by_other_ref']);
  });

  it('refuses a code, a reference or an item that appears twice in the batch (the later row)', () => {
    const ctx = ctxOf([stored({ id: 'a', code: 'A', externalSystem: 'sage', externalRef: '1' })]);
    expect(codes([row(0, { code: 'N', description: 'd' }), row(1, { code: 'N', description: 'd' })], ctx)).toEqual(['1:duplicate_in_request']);
    expect(codes([
      row(0, { code: 'P', description: 'd', external_system: 'sage', external_ref: '5' }),
      row(1, { code: 'Q', description: 'd', external_system: 'sage', external_ref: '5' }),
    ], ctx)).toEqual(['1:duplicate_in_request']);
    // row 0 addresses item A by its reference (renaming it), row 1 addresses the same item by its old code
    expect(codes([row(0, { code: 'A2', external_system: 'sage', external_ref: '1' }), row(1, { code: 'A', description: 'x' })], ctx)).toEqual(['1:duplicate_in_request']);
  });

  it('refuses a create with no description and a row with no code', () => {
    expect(codes([row(0, { code: 'N' })], ctxOf([]))).toEqual(['0:description_required']);
    expect(codes([{ index: 4, fields: { description: 'd' } }], ctxOf([]))).toEqual(['4:code_required']);
  });

  it('refuses an unknown or inactive category, and an ambiguous name', () => {
    const ctx = ctxOf([]);
    expect(codes([row(0, { code: 'N', description: 'd', category_code: 'nope' })], ctx)).toEqual(['0:category_not_found']);
    expect(codes([row(0, { code: 'N', description: 'd', category_id: CAT_OLD })], ctx)).toEqual(['0:category_inactive']);
    ctx.categories.push({ id: 'x', code: null, name: 'optics', isActive: true });
    expect(codes([row(0, { code: 'N', description: 'd', category_name: 'Optics' })], ctx)).toEqual(['0:category_ambiguous']);
  });

  it('refuses a GL account that is not this company\'s, or is inactive', () => {
    const ctx = ctxOf([]);
    expect(codes([row(0, { code: 'N', description: 'd', sales_account_id: '55555555-5555-4555-8555-555555555555' })], ctx)).toEqual(['0:account_not_found']);
    expect(codes([row(0, { code: 'N', description: 'd', purchases_account_id: INACTIVE_ACC })], ctx)).toEqual(['0:account_inactive']);
    expect(codes([row(0, { code: 'N', description: 'd', purchases_account_id: ACC, sales_account_id: ACC })], ctx)).toEqual([]);
  });

  it('refuses a service that is inventory tracked, on create and on update', () => {
    expect(codes([row(0, { code: 'S', description: 'd', item_type: 'service', inventory_tracked: true })], ctxOf([]))).toEqual(['0:service_cannot_be_tracked']);
    const tracked = stored({ id: 'a', code: 'A', inventoryTracked: true });
    expect(codes([row(0, { code: 'A', item_type: 'service' })], ctxOf([tracked]))).toEqual(['0:service_cannot_be_tracked']);
    expect(codes([row(0, { code: 'A', item_type: 'service', inventory_tracked: false })], ctxOf([tracked]))).toEqual([]);
  });

  it('refuses turning an item with stock movements into a service', () => {
    const a = stored({ id: 'a', code: 'A' });
    expect(codes([row(0, { code: 'A', item_type: 'service' })], ctxOf([a], ['a']))).toEqual(['0:has_stock_movements']);
    expect(codes([row(0, { code: 'A', item_type: 'service' })], ctxOf([a]))).toEqual([]);
  });

  it('refuses a deleted item', () => {
    expect(codes([row(0, { code: 'A', description: 'd' })], ctxOf([stored({ id: 'a', code: 'A', deleted: true })]))).toEqual(['0:item_deleted']);
  });

  it('keeps going after a refusal: every refused row is reported, not the first', () => {
    const { refusals, planned } = planItemRows([
      row(0, { code: 'A' }), row(1, { code: 'B', description: 'ok' }), row(2, { code: 'C', description: 'd', category_code: 'zzz' }),
    ], ctxOf([]));
    expect(refusals.map((r) => r.index)).toEqual([0, 2]);
    expect(planned.map((p) => p.index)).toEqual([1]);
  });

  it('an update by id refuses a code or reference another item holds', () => {
    const a = stored({ id: 'a', code: 'A' });
    const b = stored({ id: 'b', code: 'B', externalSystem: 'sage', externalRef: '2' });
    expect(codes([row(0, { code: 'B' }, 'a')], ctxOf([a, b]))).toEqual(['0:code_in_use']);
    expect(codes([row(0, { external_system: 'sage', external_ref: '2' }, 'a')], ctxOf([a, b]))).toEqual(['0:external_ref_in_use']);
    expect(codes([row(0, { description: 'x' }, 'missing')], ctxOf([a, b]))).toEqual(['0:item_not_found']);
  });

  it('does not re-check an unchanged account: a since-deactivated account does not fail an unchanged row', () => {
    const a = stored({ id: 'a', code: 'A', purchasesAccountId: INACTIVE_ACC });
    const { planned, refusals } = planItemRows([row(0, { code: 'A', purchases_account_id: INACTIVE_ACC })], ctxOf([a]));
    expect(refusals).toEqual([]);
    expect(planned[0]!.outcome).toBe('unchanged');
  });
});
