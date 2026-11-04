/**
 * A purchase order's lines as the detail route returns them: every `po_items` column, the account's name and
 * code, and a label ("code name") for each of the line's CC1 / CC2 / BU (budgets P5-3), each master joined on its
 * id AND the PO's company. The caller has scoped the PO to `companyId` (po_items has no company_id).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function readPoItemsLabelled(companyId: string, poId: string): Promise<DbRow[]> {
  return (await sql`
    SELECT pi.*, g.account_name, g.account_code,
           NULLIF(concat_ws(' ', c1.code, c1.name), '') AS cc1_label,
           NULLIF(concat_ws(' ', c2.code, c2.name), '') AS cc2_label,
           NULLIF(concat_ws(' ', bu.code, bu.name), '') AS bu_label
      FROM po_items pi
      LEFT JOIN gl_accounts g ON g.id = pi.gl_account_id AND g.company_id = ${companyId}::UUID
      LEFT JOIN cost_centres c1 ON c1.id = pi.cc1_id AND c1.company_id = ${companyId}::UUID
      LEFT JOIN cost_centres c2 ON c2.id = pi.cc2_id AND c2.company_id = ${companyId}::UUID
      LEFT JOIN business_units bu ON bu.id = pi.bu_id AND bu.company_id = ${companyId}::UUID
     WHERE pi.purchase_order_id = ${poId}::UUID
     ORDER BY pi.sort_order
  `) as DbRow[];
}
