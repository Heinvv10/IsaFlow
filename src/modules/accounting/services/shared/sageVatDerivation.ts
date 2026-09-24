/**
 * The VAT half of a Sage row import: what to write to `subtotal`/`tax_rate`/
 * `tax_amount` when the source row is missing one or both figures.
 *
 * R-089 (twin of K-072 round 30/31): `sageSupplierInvoiceImportService.ts`
 * and `sageCustomerImportService.ts` each derived `subtotal = total / 1.15`
 * whenever the Sage row had no subtotal — inventing 15% input/output VAT on
 * a document the source never recorded any VAT for (a non-VAT-registered
 * supplier, a zero-rated invoice, or simply a row Sage exported without a
 * subtotal). K-072 settled the same question for captured documents: **no
 * VAT is ever invented.** This is that rule for the Sage migration import,
 * shared so both importers can't drift into re-deriving it their own way.
 *
 * THE RULE. A row that states neither a subtotal nor a tax amount imports
 * with the tax the source stated: none. `taxAmount` 0, `taxRate` 0%,
 * `subtotal` = `totalAmount` — and the caller is told so (`vatNotStated`),
 * to flag the imported document for a person to review before relying on
 * its VAT. A row that states ONE of the two computes the other by plain
 * arithmetic — total minus a stated tax, or a stated subtotal minus itself
 * from the total — never by rate. Only when NEITHER exists is anything
 * invented, and what happens then is nothing.
 *
 * ZERO IS "NOT STATED", not "stated as zero". A subtotal or tax amount of
 * exactly 0 reads the same as an absent one — Sage's staging tables model
 * "no figure" and "a figure of zero" the same way (nullable numeric columns
 * that default to computed 0 in some exports), and the pre-fix code already
 * treated them alike (`Number(inv.subtotal || 0)`). This is not a behaviour
 * change; a genuinely zero subtotal on a positive-total row is not a shape
 * either importer's fixtures produce.
 */

export interface SageVatDerivation {
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  /** True when the source row carried neither a subtotal nor a tax amount. */
  vatNotStated: boolean;
}

/** Note written to the imported document so a person finds it before trusting the VAT. */
export const SAGE_VAT_NOT_STATED_NOTE =
  'VAT not stated in the Sage source — imported with no VAT. Review before relying on this figure.';

function hasFigure(raw: number | string | null | undefined): boolean {
  return raw !== null && raw !== undefined && Number(raw) !== 0;
}

/**
 * Derive `subtotal`/`taxRate`/`taxAmount` for one imported row. Never derives
 * a VAT rate from `totalAmount` alone — see the module header.
 */
export function deriveSageVat(
  rawSubtotal: number | string | null | undefined,
  rawTaxAmount: number | string | null | undefined,
  totalAmount: number,
): SageVatDerivation {
  const subtotalStated = hasFigure(rawSubtotal);
  const taxStated = hasFigure(rawTaxAmount);

  if (!subtotalStated && !taxStated) {
    return { subtotal: totalAmount, taxAmount: 0, taxRate: 0, vatNotStated: true };
  }

  const subtotal = subtotalStated ? Number(rawSubtotal) : totalAmount - Number(rawTaxAmount);
  const taxAmount = taxStated ? Number(rawTaxAmount) : totalAmount - subtotal;
  // subtotal !== 0, not > 0: a credit-note-shaped row (negative subtotal,
  // negative tax) keeps a rate consistent with its own tax amount instead of
  // reporting 0% next to a non-zero tax (review-r089-r1.md LOW-6).
  const taxRate = subtotal !== 0 ? Math.round((taxAmount / subtotal) * 100 * 100) / 100 : 0;

  return { subtotal, taxAmount, taxRate, vatNotStated: false };
}
