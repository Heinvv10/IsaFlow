/**
 * A supplier bill's due date, one precedence for every way a bill is created (migration 958; Hein, 2026-11-05):
 *   1. a due date the document or caller gave;
 *   2. the bill's own terms when someone CHOSE them ("net30", "immediate"; the page no longer sends a silent default);
 *   3. the supplier's terms;
 *   4. the company default (so a bill is never undated).
 */
import { dueDateWithDefault, ownTermsDueDate } from '../shared/paymentTerms';
import { contactTerms } from '../core/paymentTermsResolver';

/** The due date for a bill from `supplierId` dated `invoiceDate`, by the precedence above. */
export async function billDueDate(
  companyId: string, supplierId: string, invoiceDate: string,
  given: { dueDate?: string | null; paymentTerms?: string | null } = {},
): Promise<string | null> {
  if (given.dueDate) return given.dueDate;
  const own = ownTermsDueDate(invoiceDate, given.paymentTerms);
  if (own) return own;
  const t = await contactTerms(companyId, 'supplier', supplierId);
  return dueDateWithDefault(invoiceDate, t.days, t.type, t.companyDefault);
}
