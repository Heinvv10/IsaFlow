/**
 * The due date a customer's payment terms give an invoice raised on `invoiceDate`: the server-side fallback when a
 * caller names no due date (the new-invoice page fills it client-side; MCP and API callers do not). Null when the
 * customer's terms are not set or the customer is not in this company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { dueDateFromTerms } from '../shared/paymentTerms';

export async function customerTermsDueDate(companyId: string, customerId: string, invoiceDate: string): Promise<string | null> {
  const rows = (await sql`
    SELECT payment_terms, payment_terms_type FROM customers
    WHERE id = ${customerId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  return dueDateFromTerms(invoiceDate, row.payment_terms == null ? null : Number(row.payment_terms), row.payment_terms_type);
}
