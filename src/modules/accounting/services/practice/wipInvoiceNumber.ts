/**
 * Invoice-number allocation for the WIP → invoice write path.
 *
 * Split out of `practiceWipService.ts` so that file keeps headroom under the
 * 300-line module limit; the behaviour is the header INSERT and nothing else.
 *
 * The number is `MAX(existing) + 1`, which is not safe on its own: a peer in the
 * same company can commit that number between this run's read and its INSERT.
 * That arrives as a 23505, so each attempt takes its own savepoint — a caught
 * error otherwise aborts the whole transaction and the retry cannot execute a
 * single further statement. After the rollback the loop re-reads `MAX(...)`,
 * which now sees the peer's committed number, and takes the next one.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

/** Postgres `unique_violation` — another run took this invoice number first. */
const UNIQUE_VIOLATION = '23505';

const MAX_ATTEMPTS = 5;

export interface WipInvoiceHeader {
  customerId: string;
  userId: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  invoiceDate: string;
}

function isUniqueViolation(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code : undefined;
  const msg = err instanceof Error ? err.message : String(err);
  return code === UNIQUE_VIOLATION || msg.includes('unique');
}

/**
 * Insert the draft WIP invoice header, retrying the number on a peer's
 * collision. Must run inside the request transaction — the savepoint per
 * attempt is what makes the retry possible.
 *
 * The retry deliberately does NOT offset the number by the attempt count: the
 * re-read `MAX(...)` already reflects whatever the peer committed, so adding the
 * attempt would skip a number and leave a gap in the invoice sequence.
 */
export async function insertWipInvoice(
  companyId: string,
  header: WipInvoiceHeader,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const maxRows = (await sql`
      SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '[0-9]+$') AS INTEGER)), 0) AS max_num
      FROM customer_invoices WHERE company_id = ${companyId}::UUID AND invoice_number ~ '^INV-[0-9]+$'
    `) as DbRow[];
    const invoiceNumber = `INV-${String(Number(maxRows[0]?.['max_num'] ?? 0) + 1).padStart(5, '0')}`;
    try {
      const invoiceId = await withSavepoint(`wip_inv_try_${attempt}`, async () => {
        const invRows = (await sql`
          INSERT INTO customer_invoices (
            company_id, invoice_number, customer_id, client_id,
            subtotal, tax_rate, tax_amount, total_amount,
            invoice_date, status, created_by,
            currency_code, exchange_rate, functional_total
          ) VALUES (
            ${companyId}::UUID, ${invoiceNumber}, ${header.customerId}::UUID, ${header.customerId}::UUID,
            ${header.subtotal}, ${header.taxRate}, ${header.taxAmount}, ${header.totalAmount},
            ${header.invoiceDate}, 'draft', ${header.userId},
            'ZAR', 1.0, ${header.totalAmount}
          ) RETURNING id
        `) as DbRow[];
        return String(invRows[0]!.id);
      });
      return { invoiceId, invoiceNumber };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_ATTEMPTS - 1) {
        log.warn('Invoice number collision, retrying', { attempt, invoiceNumber, companyId }, 'practice');
        continue;
      }
      throw err;
    }
  }
  throw new Error(`invoice number generation failed — exhausted ${MAX_ATTEMPTS} attempts`);
}
