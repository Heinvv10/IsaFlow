/**
 * Item Bundle Service — CRUD for item bundle lines
 * All queries scoped to company_id for multi-tenant safety.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface BundleLine {
  child_item_id: string;
  quantity: number;
  sort_order?: number;
}

export interface BundleLineRow {
  id: string;
  company_id: string;
  parent_item_id: string;
  child_item_id: string;
  quantity: number;
  sort_order: number;
  created_at: string;
  // joined from items
  child_code: string | null;
  child_description: string | null;
  child_unit: string | null;
  child_selling_price_excl: number | null;
}

export async function getBundleLines(
  companyId: string,
  parentItemId: string
): Promise<BundleLineRow[]> {
  const rows = await sql`
    SELECT
      bl.id,
      bl.company_id,
      bl.parent_item_id,
      bl.child_item_id,
      bl.quantity,
      bl.sort_order,
      bl.created_at,
      ci.code            AS child_code,
      ci.description     AS child_description,
      ci.unit            AS child_unit,
      ci.selling_price_excl AS child_selling_price_excl
    FROM item_bundle_lines bl
    JOIN items ci ON ci.id = bl.child_item_id
    WHERE bl.company_id = ${companyId}
      AND bl.parent_item_id = ${parentItemId}
    ORDER BY bl.sort_order ASC, bl.created_at ASC
  ` as Row[];
  return rows as unknown as BundleLineRow[];
}

export async function upsertBundleLines(
  companyId: string,
  parentItemId: string,
  lines: BundleLine[]
): Promise<BundleLineRow[]> {
  // Delete existing lines then re-insert (replace strategy)
  await sql`
    DELETE FROM item_bundle_lines
    WHERE company_id = ${companyId}
      AND parent_item_id = ${parentItemId}
  `;

  if (lines.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      await sql`
        INSERT INTO item_bundle_lines
          (company_id, parent_item_id, child_item_id, quantity, sort_order)
        VALUES
          (${companyId}, ${parentItemId}, ${line.child_item_id},
           ${line.quantity}, ${line.sort_order ?? i})
      `;
    }
  }

  // Mark parent as bundle
  await sql`
    UPDATE items
    SET is_bundle = true, updated_at = NOW()
    WHERE id = ${parentItemId} AND company_id = ${companyId}
  `;

  log.info('Bundle lines upserted', { parentItemId, lineCount: lines.length, companyId }, 'accounting');
  return getBundleLines(companyId, parentItemId);
}

export async function deleteBundleLines(
  companyId: string,
  parentItemId: string
): Promise<void> {
  await sql`
    DELETE FROM item_bundle_lines
    WHERE company_id = ${companyId}
      AND parent_item_id = ${parentItemId}
  `;
  await sql`
    UPDATE items
    SET is_bundle = false, updated_at = NOW()
    WHERE id = ${parentItemId} AND company_id = ${companyId}
  `;
  log.info('Bundle lines deleted', { parentItemId, companyId }, 'accounting');
}

export async function expandBundle(
  companyId: string,
  parentItemId: string
): Promise<BundleLineRow[]> {
  return getBundleLines(companyId, parentItemId);
}
