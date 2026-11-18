/**
 * Writes to the item master for the MCP item tools: batch upsert, partial update, deactivate.
 *
 * `planItemBatch` is read-only (it takes the company's item-upsert lock, loads the context and decides each row);
 * `applyItemPlan` writes what a refusal-free plan says. A dry run is the first without the second, so it cannot pass
 * where the live call refuses. Every statement names `company_id`.
 *
 * The caller must not call `applyItemPlan` for a plan with refusals: nothing may be written when any row is refused.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { loadUpsertContext } from './itemUpsertContext';
import { planItemRows, type ItemPlan, type PlanInputRow, type PlannedItemRow } from './itemUpsertPlan';

export async function planItemBatch(companyId: string, rows: PlanInputRow[]): Promise<ItemPlan> {
  const ctx = await loadUpsertContext(
    companyId, rows.map((r) => r.fields), rows.map((r) => r.targetId).filter((id): id is string => !!id),
  );
  return planItemRows(rows, ctx);
}

async function insertItem(companyId: string, p: PlannedItemRow): Promise<string> {
  const v = p.values;
  const inserted = (await sql`
    INSERT INTO items (
      company_id, code, description, item_type, category_id, is_active, unit, cost_price, selling_price_excl,
      vat_on_sales, vat_on_purchases, sales_account_id, purchases_account_id, inventory_tracked, notes,
      external_system, external_ref, external_document_number
    ) VALUES (
      ${companyId}::UUID, ${v.code ?? p.code}, ${v.description ?? ''}, ${v.item_type ?? 'physical'},
      ${v.category_id ?? null}::UUID, ${v.is_active ?? true}, ${v.unit ?? 'each'}, ${v.cost_price ?? 0},
      ${v.selling_price_excl ?? 0}, ${v.vat_on_sales ?? 'standard'}, ${v.vat_on_purchases ?? 'standard'},
      ${v.sales_account_id ?? null}::UUID, ${v.purchases_account_id ?? null}::UUID, ${v.inventory_tracked ?? false},
      ${v.notes ?? null}, ${v.external_system ?? null}, ${v.external_ref ?? null}, ${v.external_document_number ?? null}
    ) RETURNING id
  `) as DbRow[];
  return String(inserted[0]!.id);
}

async function updateItemRow(companyId: string, p: PlannedItemRow): Promise<void> {
  const v = p.values;
  // A null parameter keeps the column: the tools never clear a field.
  const updated = (await sql`
    UPDATE items SET
      code = COALESCE(${v.code ?? null}, code),
      description = COALESCE(${v.description ?? null}, description),
      item_type = COALESCE(${v.item_type ?? null}, item_type),
      category_id = COALESCE(${v.category_id ?? null}::UUID, category_id),
      unit = COALESCE(${v.unit ?? null}, unit),
      cost_price = COALESCE(${v.cost_price ?? null}::NUMERIC, cost_price),
      selling_price_excl = COALESCE(${v.selling_price_excl ?? null}::NUMERIC, selling_price_excl),
      vat_on_sales = COALESCE(${v.vat_on_sales ?? null}, vat_on_sales),
      vat_on_purchases = COALESCE(${v.vat_on_purchases ?? null}, vat_on_purchases),
      sales_account_id = COALESCE(${v.sales_account_id ?? null}::UUID, sales_account_id),
      purchases_account_id = COALESCE(${v.purchases_account_id ?? null}::UUID, purchases_account_id),
      inventory_tracked = COALESCE(${v.inventory_tracked ?? null}::BOOLEAN, inventory_tracked),
      is_active = COALESCE(${v.is_active ?? null}::BOOLEAN, is_active),
      notes = COALESCE(${v.notes ?? null}, notes),
      external_system = COALESCE(${v.external_system ?? null}, external_system),
      external_ref = COALESCE(${v.external_ref ?? null}, external_ref),
      external_document_number = COALESCE(${v.external_document_number ?? null}, external_document_number),
      updated_at = NOW()
    WHERE id = ${p.itemId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as DbRow[];
  // A miss rolls the whole batch back (the caller rethrows): the plan read this row a moment ago.
  if (updated.length !== 1) throw new Error(`items: row ${p.index} matched no item of this company when it was written`);
}

/** Write a refusal-free plan. Returns the id of every row that was created or updated, by row index. */
export async function applyItemPlan(companyId: string, planned: PlannedItemRow[]): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const p of planned) {
    if (p.outcome === 'created') ids.set(p.index, await insertItem(companyId, p));
    else if (p.outcome === 'updated') {
      await updateItemRow(companyId, p);
      ids.set(p.index, p.itemId as string);
    }
  }
  log.info('Items written', { companyId, rows: planned.length, written: ids.size }, 'accounting');
  return ids;
}

/**
 * Set `is_active = false`. Idempotent: an already-inactive item is reported as such and not touched.
 * Returns null when this company has no such item (or it has been deleted).
 */
export async function deactivateCatalogItem(
  companyId: string, itemId: string, opts: { dryRun: boolean },
): Promise<{ id: string; code: string; wasActive: boolean } | null> {
  const found = (await sql`
    SELECT id, code, is_active FROM items
    WHERE id = ${itemId}::UUID AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    FOR UPDATE
  `) as DbRow[];
  const row = found[0];
  if (!row) return null;
  const wasActive = row.is_active !== false;
  if (wasActive && !opts.dryRun) {
    await sql`UPDATE items SET is_active = false, updated_at = NOW() WHERE id = ${itemId}::UUID AND company_id = ${companyId}::UUID`;
    log.info('Item deactivated', { id: itemId, companyId }, 'accounting');
  }
  return { id: String(row.id), code: String(row.code), wasActive };
}
