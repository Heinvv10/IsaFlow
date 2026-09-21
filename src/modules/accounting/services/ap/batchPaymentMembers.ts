/**
 * The payments inside one batch, as the batch detail page lists them. The page
 * always read `batch.payments`, but the single-batch GET never returned it, so
 * every batch showed "No individual payments in this batch".
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface BatchMember {
  id: string;
  paymentNumber: string;
  supplierName: string;
  amount: number;
  status: string;
}

export async function getBatchMembers(companyId: string, batchId: string): Promise<BatchMember[]> {
  const rows = (await sql`
    SELECT sp.id, sp.payment_number, sp.total_amount, sp.status,
           COALESCE(NULLIF(s.company_name, ''), s.name) AS supplier_name
    FROM supplier_payments sp
    LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
    WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID
    ORDER BY sp.payment_number
  `) as DbRow[];
  return rows.map((r) => ({
    id: String(r.id),
    paymentNumber: String(r.payment_number ?? ''),
    supplierName: String(r.supplier_name ?? ''),
    amount: Number(r.total_amount),
    status: String(r.status),
  }));
}
