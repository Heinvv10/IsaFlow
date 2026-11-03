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
export type EditLine = InvoiceLine & { cc1Id?: string | null; cc2AtLoad?: string; timeEntryId?: string | null };

export interface InvoicePutItem {
  description: string; quantity: number; unitPrice: number; taxRate: number; discount: number;
  glAccountId: string | null; projectId: string | null; cc2Id: string | null; buId: string | null; cc1Id: string | null;
  timeEntryId: string | null;
}

export interface InvoicePutBody {
  id: string; clientId: string; invoiceDate: string; dueDate?: string; billingPeriodStart?: string; billingPeriodEnd?: string;
  taxRate: number; notes?: string; currencyCode: string; exchangeRate: number; projectId: string | null; items: InvoicePutItem[];
}

interface Draft { form: InvoiceHeaderForm; lines: readonly EditLine[]; taxMode: TaxMode }

/**
 * Every line with something in it. A line that cannot be stored (droppedLineProblem) stays in the body, so the body
 * differs from the server's and autosave says why it holds; such a body is never sent, since every send first refuses
 * on saveProblem or autosaveProblem, and without one this is exactly the lines the server stores.
 */
const savedLines = (lines: readonly EditLine[]) => lines.filter((l) => l.description || l.unitPrice);

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
    notes: form.notes, // '' clears them; left out, the server would keep the old notes and Saved would be untrue
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
      // A WIP line's time entry goes back with it, so the PUT (which replaces every line) keeps the link. Always sent,
      // null on an unlinked line: on a WIP invoice the server refuses a body without it (it cannot tell a removed
      // line from a client that does not know the links), and releases only links this body leaves out.
      timeEntryId: l.timeEntryId || null,
    })),
  };
}

const finite = (...ns: number[]) => ns.every((n) => Number.isFinite(n));

/**
 * Why a line on screen would not reach the invoice, or null. The screen's total counts every line, so a body that
 * dropped one would store, and approve, a different invoice from the one shown. A line with nothing in it (no
 * description, no price) is left out quietly: it adds nothing. `zeroPriceKept`: the edit page stores a described line
 * at R0; the new page does not.
 */
export function droppedLineProblem(lines: readonly Pick<EditLine, 'description' | 'unitPrice' | 'quantity'>[], zeroPriceKept: boolean): string | null {
  for (const l of lines) {
    if (!l.description && !l.unitPrice) continue;
    const name = l.description ? `"${l.description}"` : 'A line';
    if (!finite(l.unitPrice) || l.unitPrice < 0) return `${name} has a negative price: enter a discount as a Disc. % on the line instead, or remove it`;
    if (!l.description) return `A line of ${l.unitPrice.toFixed(2)} has no description: add one, or remove the line`;
    if (!finite(l.quantity) || l.quantity <= 0) return `${name} needs a quantity above 0`;
    if (!zeroPriceKept && l.unitPrice <= 0) return `${name} needs a price above 0`;
  }
  return null;
}

export type StoredDates = Partial<Record<'dueDate' | 'billingPeriodStart' | 'billingPeriodEnd', boolean>>;
const DATE_NAMES: [keyof StoredDates, string][] = [['dueDate', 'due date'], ['billingPeriodStart', 'period start'], ['billingPeriodEnd', 'period end']];

/** The server keeps a date the body leaves out, so a stored one cleared here would read Saved and stay: refuse it. */
function clearedDateProblem(form: InvoiceHeaderForm, stored: StoredDates): string | null {
  const cleared = DATE_NAMES.find(([key]) => stored[key] && !form[key]);
  return cleared ? `The ${cleared[1]} cannot be cleared here: enter a date` : null;
}

/** Why the Save button (and Approve & email) refuses this draft, or null. Shown on screen. */
export function saveProblem({ form, lines, taxMode }: Draft, refused: Refused, stored: StoredDates = {}): string | null {
  if (!form.clientId) return 'Select a client';
  const rate = effectiveTaxRate(taxMode, form.taxRate);
  const tooSmall = lines.find((l) => l.description && pricesToNothing(taxMode, l.unitPrice, rate));
  if (tooSmall) return pricesToNothingMessage(tooSmall.description);
  const dropped = droppedLineProblem(lines, true);
  if (dropped) return dropped;
  if (!lines.some((l) => l.description)) return 'Add at least one line item';
  return invoiceDateProblem(form, refused) ?? clearedDateProblem(form, stored);
}

/**
 * Why autosave holds this draft back, or null: Save's refusals, plus no priced line yet, and a rate or exchange rate
 * the server would refuse (a 400 would stop autosave for a value still being typed).
 */
export function autosaveProblem(draft: Draft, refused: Refused, stored: StoredDates = {}): string | null {
  const refusal = saveProblem(draft, refused, stored);
  if (refusal) return refusal;
  const { form, lines } = draft;
  if (!lines.some((l) => l.description && l.unitPrice > 0 && l.quantity > 0)) return 'Add a priced line';
  if (!finite(form.taxRate, form.exchangeRate) || form.taxRate < 0 || form.taxRate > 100 || form.exchangeRate <= 0) return 'Check the VAT and exchange rates';
  return null;
}
