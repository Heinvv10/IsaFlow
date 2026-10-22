/**
 * The two per-document facts an open-items row carries beside the aging's own
 * figures: its CC1 / CC2 / BU codes and whether a supporting document is filed.
 *
 * Dimensions: an invoice's lines decide. One value across every line (blank
 * included) is that value; two or more is 'MIXED'; an invoice with no lines is
 * blank. A credit note carries its dimensions on its header. A payment has none.
 *
 * Every read is this company's rows only: the invoice / note joins and every
 * cost-centre and business-unit join carry company_id, and the document check
 * goes through core/documentQueryService.entityIdsWithDocuments, which fences
 * on the entity's own table.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { AccountingEntityType } from '@/types/procurement/document.types';
import { entityIdsWithDocuments } from '@/modules/accounting/services/core/documentQueryService';
import { str } from './glLineExportRows';

export interface DocDimensions {
  cc1: string | null;
  cc2: string | null;
  bu: string | null;
}

function toDims(r: DbRow): DocDimensions {
  return { cc1: str(r.cc1_code), cc2: str(r.cc2_code), bu: str(r.bu_code) };
}

/** Line-derived dimensions of supplier ('ap') or customer ('ar') invoices, keyed by invoice id. */
export async function invoiceDimensions(
  companyId: string,
  side: 'ap' | 'ar',
  ids: readonly string[],
): Promise<Map<string, DocDimensions>> {
  if (ids.length === 0) return new Map();
  const idList = ids as string[];
  // COUNT(DISTINCT COALESCE(code, '')) treats a blank line as a value of its
  // own, so a half-tagged invoice reads MIXED rather than as fully tagged.
  const rows = (side === 'ap'
    ? await sql`
        SELECT i.supplier_invoice_id AS doc_id,
          CASE WHEN COUNT(DISTINCT COALESCE(c1.code, '')) > 1 THEN 'MIXED' ELSE MAX(c1.code)::TEXT END AS cc1_code,
          CASE WHEN COUNT(DISTINCT COALESCE(c2.code, '')) > 1 THEN 'MIXED' ELSE MAX(c2.code)::TEXT END AS cc2_code,
          CASE WHEN COUNT(DISTINCT COALESCE(b.code, '')) > 1 THEN 'MIXED' ELSE MAX(b.code)::TEXT END AS bu_code
        FROM supplier_invoice_items i
        JOIN supplier_invoices si ON si.id = i.supplier_invoice_id AND si.company_id = ${companyId}::UUID
        LEFT JOIN cost_centres c1 ON c1.id = i.cc1_id AND c1.company_id = ${companyId}::UUID
        LEFT JOIN cost_centres c2 ON c2.id = i.cc2_id AND c2.company_id = ${companyId}::UUID
        LEFT JOIN business_units b ON b.id = i.bu_id AND b.company_id = ${companyId}::UUID
        WHERE i.supplier_invoice_id = ANY(${idList}::UUID[])
        GROUP BY i.supplier_invoice_id`
    : await sql`
        SELECT i.invoice_id AS doc_id,
          CASE WHEN COUNT(DISTINCT COALESCE(c1.code, '')) > 1 THEN 'MIXED' ELSE MAX(c1.code)::TEXT END AS cc1_code,
          CASE WHEN COUNT(DISTINCT COALESCE(c2.code, '')) > 1 THEN 'MIXED' ELSE MAX(c2.code)::TEXT END AS cc2_code,
          CASE WHEN COUNT(DISTINCT COALESCE(b.code, '')) > 1 THEN 'MIXED' ELSE MAX(b.code)::TEXT END AS bu_code
        FROM customer_invoice_items i
        JOIN customer_invoices ci ON ci.id = i.invoice_id AND ci.company_id = ${companyId}::UUID
        LEFT JOIN cost_centres c1 ON c1.id = i.cc1_id AND c1.company_id = ${companyId}::UUID
        LEFT JOIN cost_centres c2 ON c2.id = i.cc2_id AND c2.company_id = ${companyId}::UUID
        LEFT JOIN business_units b ON b.id = i.bu_id AND b.company_id = ${companyId}::UUID
        WHERE i.invoice_id = ANY(${idList}::UUID[])
        GROUP BY i.invoice_id`) as DbRow[];
  return new Map(rows.map((r) => [String(r.doc_id), toDims(r)]));
}

/** Header dimensions of credit notes, keyed by credit-note id. */
export async function creditNoteDimensions(
  companyId: string,
  ids: readonly string[],
): Promise<Map<string, DocDimensions>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT cn.id AS doc_id, c1.code AS cc1_code, c2.code AS cc2_code, b.code AS bu_code
    FROM credit_notes cn
    LEFT JOIN cost_centres c1 ON c1.id = cn.cc1_id AND c1.company_id = ${companyId}::UUID
    LEFT JOIN cost_centres c2 ON c2.id = cn.cc2_id AND c2.company_id = ${companyId}::UUID
    LEFT JOIN business_units b ON b.id = cn.bu_id AND b.company_id = ${companyId}::UUID
    WHERE cn.company_id = ${companyId}::UUID AND cn.id = ANY(${ids as string[]}::UUID[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.doc_id), toDims(r)]));
}

/** Ids, per entity type, that hold at least one active document. Sequential: one pg client per request. */
export async function documentsOnFile(
  companyId: string,
  byType: ReadonlyArray<readonly [AccountingEntityType, readonly string[]]>,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const [type, ids] of byType) {
    for (const id of await entityIdsWithDocuments(companyId, type, ids)) out.add(id);
  }
  return out;
}
