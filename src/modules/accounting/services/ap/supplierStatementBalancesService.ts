import { sql } from '@/lib/neon';
import { getAPAging } from './apAgingService';
import type { AgingBucket } from '../../types/ap.types';

export interface SupplierStatementBalance extends AgingBucket {
  /** Payments and credit-note amounts not already settling an invoice. */
  onAccount: number;
  netBalance: number;
}

/** Preserve invoice ageing; show on-account funds separately to avoid double deduction. */
export async function getSupplierStatementBalances(companyId: string, asAtDate: string): Promise<SupplierStatementBalance[]> {
  const aging = await getAPAging(companyId, asAtDate);
  const credits = await sql`
    SELECT s.id AS entity_id, s.name AS entity_name, SUM(funds.amount) AS on_account
    FROM (
      SELECT sp.supplier_id, GREATEST(sp.total_amount - COALESCE((
        SELECT SUM(pa.amount_allocated)
        FROM payment_allocations pa
        JOIN supplier_invoices si ON si.id = pa.invoice_id
        WHERE pa.payment_id = sp.id AND si.company_id = ${companyId}::UUID
          AND si.supplier_id = sp.supplier_id
          AND si.status NOT IN ('draft', 'cancelled')
          -- Same population as apAgingService: a deleted bill is not payable.
          AND si.deleted_at IS NULL
          AND si.invoice_date <= ${asAtDate}::DATE
      ), 0), 0) AS amount
      FROM supplier_payments sp
      WHERE sp.company_id = ${companyId}::UUID
        AND sp.status NOT IN ('draft', 'cancelled')
        AND sp.payment_date <= ${asAtDate}::DATE
      UNION ALL
      SELECT cn.supplier_id, GREATEST(cn.total_amount - CASE WHEN EXISTS (
        SELECT 1 FROM supplier_invoices si
        WHERE si.id = cn.supplier_invoice_id AND si.company_id = ${companyId}::UUID
          AND si.supplier_id = cn.supplier_id
          AND si.status NOT IN ('draft', 'cancelled')
          -- Same population as apAgingService: a deleted bill is not payable.
          AND si.deleted_at IS NULL
          AND si.invoice_date <= ${asAtDate}::DATE
      ) THEN cn.applied_amount ELSE 0 END, 0) AS amount
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}::UUID AND cn.type = 'supplier'
        AND cn.status NOT IN ('draft', 'cancelled')
        AND cn.credit_date <= ${asAtDate}::DATE
    ) funds
    JOIN suppliers s ON s.id = funds.supplier_id AND s.company_id = ${companyId}::UUID
    GROUP BY s.id, s.name
    HAVING SUM(funds.amount) > 0
  ` as { entity_id: string; entity_name: string; on_account: string | number }[];
  const balances = new Map<string, SupplierStatementBalance>(aging.map(row => [row.entityId, {
    ...row, onAccount: 0, netBalance: Number(row.total.toFixed(2)),
  }]));
  for (const credit of credits) {
    const row = balances.get(credit.entity_id) ?? {
      entityId: credit.entity_id, entityName: credit.entity_name,
      current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 0,
      onAccount: 0, netBalance: 0,
    };
    row.onAccount = Number(credit.on_account);
    row.netBalance = Number((row.total - row.onAccount).toFixed(2));
    balances.set(row.entityId, row);
  }
  return [...balances.values()].sort((a, b) => b.netBalance - a.netBalance);
}
