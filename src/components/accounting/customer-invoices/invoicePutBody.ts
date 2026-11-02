/**
 * The edit page's draft PUT body (customer-invoices-detail), built in ONE place for the Save button, autosave and
 * Approve & email, so all three send the same thing. Built from one render's form, lines and mode together: mode and
 * prices change together (linesForModeChange), so a body that took its lines from one render and its mode from another
 * would read gross prices as ex-VAT (PR D's warning).
 *
 * Pure: safe in a client bundle.
 */
import { invoiceDateProblem, type InvoiceHeaderForm, type Refused } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { effectiveTaxRate, pricesToNothing, pricesToNothingMessage, storedUnitPrice, type TaxMode } from './taxMode';

/** CC1 is re-sent only while the line's CC2 is the one it loaded with; otherwise null, so derivation sets it. */
export type EditLine = InvoiceLine & { cc1Id?: string | null; cc2AtLoad?: string };

export interface InvoicePutItem {
  description: string; quantity: number; unitPrice: number; taxRate: number; discount: number;
  glAccountId: string | null; projectId: string | null; cc2Id: string | null; buId: string | null; cc1Id: string | null;
}

export interface InvoicePutBody {
  id: string; clientId: string; invoiceDate: string; dueDate?: string; billingPeriodStart?: string; billingPeriodEnd?: string;
  taxRate: number; notes?: string; currencyCode: string; exchangeRate: number; projectId: string | null; items: InvoicePutItem[];
}

interface Draft { form: InvoiceHeaderForm; lines: readonly EditLine[]; taxMode: TaxMode }

const savedLines = (lines: readonly EditLine[]) => lines.filter((l) => l.description && l.unitPrice >= 0 && l.quantity > 0);

export function invoicePutBody(id: string, { form, lines, taxMode }: Draft): InvoicePutBody {
  const taxRate = effectiveTaxRate(taxMode, form.taxRate);
  return {
    id,
    clientId: form.clientId,
    invoiceDate: form.invoiceDate,
    dueDate: form.dueDate || undefined,
    billingPeriodStart: form.billingPeriodStart || undefined,
    billingPeriodEnd: form.billingPeriodEnd || undefined,
    taxRate,
    notes: form.notes || undefined,
    currencyCode: form.currencyCode,
    exchangeRate: form.exchangeRate,
    projectId: form.projectId || null,
    items: savedLines(lines).map((l) => ({
      description: l.description, quantity: l.quantity,
      unitPrice: storedUnitPrice(taxMode, l.unitPrice, taxRate), taxRate,
      discount: l.discount || 0,
      glAccountId: l.glAccountId || null,
      projectId: l.projectId || null,
      cc2Id: l.cc2Id || null,
      buId: l.buId || null,
      cc1Id: l.cc2Id === (l.cc2AtLoad ?? '') ? (l.cc1Id ?? null) : null,
    })),
  };
}

/** Why the Save button refuses this draft, or null. Shown on screen. */
export function saveProblem({ form, lines, taxMode }: Draft, refused: Refused): string | null {
  if (!form.clientId) return 'Select a client';
  const rate = effectiveTaxRate(taxMode, form.taxRate);
  const tooSmall = lines.find((l) => l.description && pricesToNothing(taxMode, l.unitPrice, rate));
  if (tooSmall) return pricesToNothingMessage(tooSmall.description);
  if (savedLines(lines).length === 0) return 'Add at least one line item';
  return invoiceDateProblem(form, refused);
}

const finite = (...ns: number[]) => ns.every((n) => Number.isFinite(n));

/**
 * Why autosave holds this draft back, or null. Stricter than Save: a line half-typed (a description with no quantity,
 * a price with no description) would be dropped from the body, so the stored draft would lose it mid-edit; a rate or
 * exchange rate the server refuses would stop autosave on a 400 for a value still being typed.
 */
export function autosaveProblem(draft: Draft, refused: Refused): string | null {
  const refusal = saveProblem(draft, refused);
  if (refusal) return refusal;
  const { form, lines } = draft;
  if (!lines.some((l) => l.description && l.unitPrice > 0 && l.quantity > 0)) return 'Add a priced line';
  const halfTyped = lines.some((l) => (l.description || l.unitPrice) && !(l.description && finite(l.unitPrice, l.quantity) && l.unitPrice >= 0 && l.quantity > 0));
  if (halfTyped) return 'Finish or remove the incomplete line';
  if (!finite(form.taxRate, form.exchangeRate) || form.taxRate < 0 || form.taxRate > 100 || form.exchangeRate <= 0) return 'Check the VAT and exchange rates';
  return null;
}
