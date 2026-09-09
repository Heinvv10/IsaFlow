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
 */

import { withSavepoint } from '@/lib/neon';
import { reserveNextDocumentNumber } from './companySettingsService';

const MAX_ATTEMPTS = 5;

export async function insertWithReservedNumber<T>(
  companyId: string,
  documentType: string,
  savepointPrefix: string,
  insert: (documentNumber: string) => Promise<T>,
): Promise<T> {
  let documentNumber = await reserveNextDocumentNumber(companyId, documentType);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const number = documentNumber;
    try {
      return await withSavepoint(`${savepointPrefix}${attempt}`, () => insert(number));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== '23505' || attempt === MAX_ATTEMPTS - 1) throw err;
      documentNumber = await reserveNextDocumentNumber(companyId, documentType);
    }
  }
  // Unreachable: the last attempt either returns or rethrows above.
  throw new Error(`No free ${documentType} number after ${MAX_ATTEMPTS} attempts`);
}
