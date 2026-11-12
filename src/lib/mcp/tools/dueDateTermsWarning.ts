/**
 * Warn when an MCP-created bill's given due_date disagrees with its supplier's OWN payment terms.
 *
 * The date is kept: a due date the caller or document gave wins over the supplier's terms (plan
 * docs/plans/2026-11-05-payment-terms-due-by-date.md, precedence step 1), since a real supplier invoice can state its
 * own. The warning exists because an agent copying another system's due date (Sage's invoice + 90 for a supplier on
 * "3 months after statement", 2026-11-10) otherwise stores a wrong date as if a person chose it. A supplier with no
 * terms set gets no warning: the company default is not the supplier's terms.
 */
import { contactTerms } from '@/modules/accounting/services/core/paymentTermsResolver';
import { dueDateFromTerms, ownTermsDueDate } from '@/modules/accounting/services/shared/paymentTerms';

export interface DueDateCheck {
  supplierId: string;
  invoiceDate: string;
  dueDate: string | undefined;
  /** The bill's own payment_terms text ('net60'); a date they give is a deliberate choice, not a copied one. */
  paymentTerms?: string;
  /** Prefix naming the element, e.g. 'invoices[3]: '; '' for a single bill. */
  label: string;
}

/** One warning per bill whose given due date differs from its supplier's own terms. Reads each supplier once. */
export async function dueDateTermsWarnings(companyId: string, checks: DueDateCheck[]): Promise<string[]> {
  const cache = new Map<string, Awaited<ReturnType<typeof contactTerms>>>();
  const warnings: string[] = [];
  for (const c of checks) {
    if (!c.dueDate || c.dueDate === ownTermsDueDate(c.invoiceDate, c.paymentTerms)) continue;
    let t = cache.get(c.supplierId);
    if (!t) {
      t = await contactTerms(companyId, 'supplier', c.supplierId);
      cache.set(c.supplierId, t);
    }
    // Null when the supplier has no terms set: the company default is not its terms, so no warning.
    const termsDate = dueDateFromTerms(c.invoiceDate, t.days, t.type);
    if (termsDate === null || termsDate === c.dueDate) continue;
    warnings.push(
      `${c.label}due_date ${c.dueDate} differs from the supplier's payment terms (${termsDate}); kept as given. `
      + 'Omit due_date to follow the terms, unless the supplier\'s document states this date.',
    );
  }
  return warnings;
}
