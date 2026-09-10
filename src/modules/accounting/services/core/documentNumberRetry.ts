/**
 * Reserve a company document number and insert under it, retrying past a
 * number some legacy row already holds.
 *
 * Extracted so every caller that mints into a unique numbering domain shares
 * one loop instead of carrying its own copy. Two properties make it terminate and make it
 * safe to use inside a request transaction:
 *
 * - `reserveNextDocumentNumber` runs OUTSIDE the savepoint, so the number a
 *   failed INSERT burned is not handed back by the rollback. Reserving inside
 *   would re-issue the same number forever.
 * - Each attempt is savepointed, so a 23505 rolls back only its own INSERT.
 *   Without that the whole request transaction is left aborted (25P02) and the
 *   retry cannot run.
 *
 * A caller that must REFUSE a duplicate rather than renumber must not use this
 * helper — the point of it is that the number is ours to choose.
 *
 * Only a 23505 raised by the NUMBERING index renumbers. The attempt closure now
 * writes line items too, and any other unique constraint the header or its
 * lines touch also raises 23505: read as "that number is taken", such a failure
 * burned four more sequence numbers and then surfaced an error naming the wrong
 * cause. The caller therefore names the index it is retrying past.
 *
 * A caller may name SEVERAL indexes. `customer_quotes` is the case that needs
 * it: two parallel remediation branches add the same unique (company_id,
 * quote_number) under different names, so which one raises depends on which
 * migration reached the database — and renumbering must work either way.
 */

import { withSavepoint } from '@/lib/neon';
import { reserveNextDocumentNumber } from './companySettingsService';

const MAX_ATTEMPTS = 5;

export async function insertWithReservedNumber<T>(
  companyId: string,
  documentType: string,
  savepointPrefix: string,
  /**
   * The unique index(es) on the document number, e.g.
   * uq_customer_invoices_company_number. Several may be named when more than one
   * index can enforce the same numbering domain.
   */
  numberConstraint: string | string[],
  insert: (documentNumber: string) => Promise<T>,
): Promise<T> {
  const numberConstraints = Array.isArray(numberConstraint) ? numberConstraint : [numberConstraint];
  let documentNumber = await reserveNextDocumentNumber(companyId, documentType);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const number = documentNumber;
    try {
      return await withSavepoint(`${savepointPrefix}${attempt}`, () => insert(number));
    } catch (err) {
      const { code, constraint } = err as { code?: string; constraint?: string };
      if (code !== '23505' || !constraint || !numberConstraints.includes(constraint)) throw err;
      if (attempt === MAX_ATTEMPTS - 1) throw err;
      documentNumber = await reserveNextDocumentNumber(companyId, documentType);
    }
  }
  // Unreachable: the last attempt either returns or rethrows above.
  throw new Error(`No free ${documentType} number after ${MAX_ATTEMPTS} attempts`);
}
