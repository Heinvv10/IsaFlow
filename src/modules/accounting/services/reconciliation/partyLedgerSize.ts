/**
 * The cost guard for `party_ledger_check`.
 *
 * Every document of the party is read, joined to its journal chain and compared
 * BEFORE `detail` or `limit` apply, so `summary` costs what `full` costs. A
 * party with an implausible number of documents is refused up front, with the
 * count, rather than left to time out holding the request's transaction.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export const MAX_PARTY_DOCUMENTS = 20000;

export class PartyTooLargeError extends Error {
  constructor(readonly documents: number, readonly limit: number) {
    super(
      `This party has ${documents} documents dated on or before as_at, more than the ${limit} one call can compare. `
      + 'Use an earlier as_at, or reconcile_subledger for the company-level view.',
    );
    this.name = 'PartyTooLargeError';
  }
}

/** Documents dated on or before as_at, counted by the cheapest filter each table has. */
export async function countPartyDocuments(
  side: 'ar' | 'ap', companyId: string, partyId: string, asAtDate: string,
): Promise<number> {
  const rows = (await (side === 'ar'
    ? sql`
      SELECT (SELECT COUNT(*) FROM customer_invoices WHERE company_id = ${companyId}::UUID
                AND COALESCE(client_id, customer_id) = ${partyId}::UUID
                AND COALESCE(invoice_date, created_at::date) <= ${asAtDate}::DATE)
           + (SELECT COUNT(*) FROM customer_payments WHERE company_id = ${companyId}::UUID
                AND client_id = ${partyId}::UUID AND payment_date <= ${asAtDate}::DATE)
           + (SELECT COUNT(*) FROM credit_notes WHERE company_id = ${companyId}::UUID AND type = 'customer'
                AND client_id = ${partyId}::UUID AND credit_date <= ${asAtDate}::DATE)
           + (SELECT COUNT(*) FROM customer_write_offs WHERE company_id = ${companyId}::UUID
                AND client_id = ${partyId}::UUID AND write_off_date <= ${asAtDate}::DATE) AS n`
    : sql`
      SELECT (SELECT COUNT(*) FROM supplier_invoices WHERE company_id = ${companyId}::UUID
                AND supplier_id = ${partyId}::UUID
                AND COALESCE(invoice_date, created_at::date) <= ${asAtDate}::DATE)
           + (SELECT COUNT(*) FROM supplier_payments WHERE company_id = ${companyId}::UUID
                AND supplier_id = ${partyId}::UUID AND payment_date <= ${asAtDate}::DATE)
           + (SELECT COUNT(*) FROM credit_notes WHERE company_id = ${companyId}::UUID AND type = 'supplier'
                AND supplier_id = ${partyId}::UUID AND credit_date <= ${asAtDate}::DATE) AS n`)) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}

export async function assertPartySize(
  side: 'ar' | 'ap', companyId: string, partyId: string, asAtDate: string, limit = MAX_PARTY_DOCUMENTS,
): Promise<void> {
  const n = await countPartyDocuments(side, companyId, partyId, asAtDate);
  if (n > limit) throw new PartyTooLargeError(n, limit);
}
