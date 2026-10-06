/**
 * The supplier-invoice bulk action's up-front year lock (core/numberYearLocks.ts). Approve and post date each
 * bill's journal on the bill's own date; a cancel's reversal may fall in today's year instead (its original's
 * period closed), so a cancel adds this year. Taken on the request transaction before the first journal.
 */
import { sql } from '@/lib/neon';
import { journalYearOf, lockNumberYears } from '../core/numberYearLocks';

export async function lockSupplierInvoiceYears(
  companyId: string,
  invoiceIds: readonly string[],
  includeToday: boolean,
): Promise<void> {
  const rows = (await sql`
    SELECT EXTRACT(YEAR FROM invoice_date)::int AS y FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID AND id = ANY(${invoiceIds as string[]}::UUID[])
  `) as { y: number | null }[];
  await lockNumberYears(companyId, [
    ...rows.map((r) => Number(r.y)),
    ...(includeToday ? [journalYearOf(new Date())] : []),
  ]);
}
