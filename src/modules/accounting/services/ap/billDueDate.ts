/**
 * A supplier bill's due date, one precedence for every way a bill is created (migration 960; Hein, 2026-11-05):
 *   1. a due date the user, the API caller or the scanned document gave (printed due date);
 *   2. the bill's own terms when someone CHOSE them ("net30", "immediate"; the page sends none unless the user picked one);
 *   3. the supplier's CONFIRMED terms;
 *   4. terms text from the scan (lowest-ranked input: never overrides a confirmed supplier; statement wording is ignored);
 *   5. the company default (so a bill is never undated).
 */
import { dueDateWithDefault, ownTermsDueDate, readTerms } from '../shared/paymentTerms';
import { scannedTermsDueDate } from '../shared/scannedPaymentTerms';
import { contactTerms } from '../core/paymentTermsResolver';
import type { DueDateSource } from '../shared/dueDateSource';

/** The due date for a bill from `supplierId` dated `invoiceDate`, by the precedence above. */
export async function billDueDate(
  companyId: string, supplierId: string, invoiceDate: string,
  given: { dueDate?: string | null; paymentTerms?: string | null; scannedTerms?: string | null } = {},
): Promise<string | null> {
  return (await billDueDateSourced(companyId, supplierId, invoiceDate, given)).dueDate;
}

/**
 * The same, with where the date came from (migration 962). `givenAs` names who gave `dueDate`; a scanned document's
 * terms text is `document`; the bill's own chosen terms are `manual`; the supplier's terms and the default are `terms`.
 */
export async function billDueDateSourced(
  companyId: string, supplierId: string, invoiceDate: string,
  given: { dueDate?: string | null; paymentTerms?: string | null; scannedTerms?: string | null } = {},
  givenAs: 'manual' | 'document' = 'manual',
): Promise<{ dueDate: string | null; source: DueDateSource }> {
  if (given.dueDate) return { dueDate: given.dueDate, source: givenAs };
  const own = ownTermsDueDate(invoiceDate, given.paymentTerms);
  if (own) return { dueDate: own, source: 'manual' };
  const t = await contactTerms(companyId, 'supplier', supplierId);
  if (readTerms(t.days, t.type) === null) {
    const scanned = scannedTermsDueDate(invoiceDate, given.scannedTerms);
    if (scanned) return { dueDate: scanned, source: 'document' };
  }
  return { dueDate: dueDateWithDefault(invoiceDate, t.days, t.type, t.companyDefault), source: 'terms' };
}
