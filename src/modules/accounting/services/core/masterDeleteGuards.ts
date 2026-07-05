/**
 * W2 (P2.1): open-document guards for master soft-deletes.
 *
 * Masters with OPEN documents cannot be deleted out from under them —
 * invoices/payments would point at a vanished customer/supplier.
 * "Open" = any non-terminal invoice, or any unconfirmed payment.
 * Split from softDeleteService for the 300-line file cap.
 */

import { sql } from '@/lib/neon';

type CountRow = { open_count: number };

export async function assertNoOpenDocuments(
  companyId: string,
  entityType: 'customer' | 'supplier',
  entityId: string,
): Promise<void> {
  if (entityType === 'customer') {
    const inv = (await sql`
      SELECT COUNT(*)::INT AS open_count FROM customer_invoices
      WHERE COALESCE(client_id, customer_id) = ${entityId}::UUID
        AND company_id = ${companyId}::UUID
        AND deleted_at IS NULL
        AND status NOT IN ('cancelled', 'paid')
    `) as CountRow[];
    if (Number(inv[0]?.open_count ?? 0) > 0) {
      throw new Error('Cannot delete customer with open invoices — cancel or settle them first');
    }
    const pay = (await sql`
      SELECT COUNT(*)::INT AS open_count FROM customer_payments
      WHERE client_id = ${entityId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'draft'
    `) as CountRow[];
    if (Number(pay[0]?.open_count ?? 0) > 0) {
      throw new Error('Cannot delete customer with open (draft) payments — confirm or cancel them first');
    }
    return;
  }

  const inv = (await sql`
    SELECT COUNT(*)::INT AS open_count FROM supplier_invoices
    WHERE supplier_id = ${entityId}::UUID
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
      AND status NOT IN ('cancelled', 'paid')
  `) as CountRow[];
  if (Number(inv[0]?.open_count ?? 0) > 0) {
    throw new Error('Cannot delete supplier with open invoices — cancel or settle them first');
  }
  const pay = (await sql`
    SELECT COUNT(*)::INT AS open_count FROM supplier_payments
    WHERE supplier_id = ${entityId}::UUID
      AND company_id = ${companyId}::UUID
      AND status IN ('draft', 'approved')
  `) as CountRow[];
  if (Number(pay[0]?.open_count ?? 0) > 0) {
    throw new Error('Cannot delete supplier with open (unprocessed) payments — process or cancel them first');
  }
}
