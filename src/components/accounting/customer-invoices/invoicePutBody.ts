/**
 * The edit page's draft PUT body (customer-invoices-detail), built in ONE place for the Save button, autosave and
 * Approve & email, so all three send the same thing. Built from one render's form, lines and mode together: mode and
 * prices change together (taxModeSwitch.switchTaxMode), so a body that took its lines from one render and its mode from another
 * would read gross prices as ex-VAT (PR D's warning).
 *
 * Per-line VAT (formVat): prices go as typed with the mode (`amountsAre`). Each line carries its own `vatType`
 * (formVat.lineVatType: its own, else the customer's default chain) and the header no rate. A company not registered
 * for VAT ('none') sends the legacy header rate 0 and untyped lines. A line with no type yet is never sent: Save and
 * autosave refuse first (vatTypeProblem). No per-line `taxRate`.
 *
 * Pure: safe in a client bundle.
 */
import { invoiceDateProblem, type InvoiceHeaderForm, type Refused } from './invoiceHeaderForm';
import type { InvoiceLine } from './InvoiceLineItemsTable';
import { pricesToNothing, pricesToNothingMessage, type TaxMode } from './taxMode';
import { amountsAreFor, lineVatTypes, vatTypeProblem } from './formVat';
import type { AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

/** CC1 is re-sent only while the line's CC2 is the one it loaded with; otherwise null, so derivation sets it. */
export type EditLine = InvoiceLine & { cc1Id?: string | null; cc2AtLoad?: string; timeEntryId?: string | null };

export interface InvoicePutItem {
  description: string; quantity: number; unitPrice: number; vatType?: string; discount: number;
  glAccountId: string | null; projectId: string | null; cc2Id: string | null; buId: string | null; cc1Id: string | null;
  timeEntryId: string | null;
}

export interface InvoicePutBody {
  id: string; clientId: string; invoiceDate: string; dueDate?: string; billingPeriodStart?: string; billingPeriodEnd?: string;
  taxRate?: number; amountsAre: AmountsAre; notes?: string; currencyCode: string; exchangeRate: number; projectId: string | null; items: InvoicePutItem[];
}

/** `customerVat`: the customer's default VAT type as read (a line with no type of its own follows it, formVat). */
interface Draft { form: InvoiceHeaderForm; lines: readonly EditLine[]; taxMode: TaxMode; customerVat?: string | null }

/**
 * Every line with something in it. A line that cannot be stored (droppedLineProblem) stays in the body, so the body
 * differs from the server's and autosave says why it holds; such a body is never sent, since every send first refuses
 * on saveProblem or autosaveProblem, and without one this is exactly the lines the server stores.
 */
const savedLines = (lines: readonly EditLine[]) => lines.filter((l) => l.timeEntryId || l.description || l.unitPrice); // a time-entry line is never dropped (its time would be unbilled)

/**
 * `omitDueDate`: leave the due date out. A save names the due date only when the page has something to say about it (the
 * user typed it, or the page recalculated it for a moved date or customer: useDueDateFollowsTerms); an untouched one is
 * the page's old copy, and sending it would put back a date that moved since the page loaded (Re-apply, another tab)
 * and record it as set by hand. The server keeps a date the body leaves out.
 * `markClearedDue`: the user cleared a due date the invoice has. The body then carries '' (it must differ from the one
 * with the date untouched, or autosave sees no change and never says why it holds); that body is never sent, since
 * clearedDateProblem refuses it first.
 */
export function invoicePutBody(id: string, { form, lines, taxMode, customerVat }: Draft, opts: { omitDueDate?: boolean; markClearedDue?: boolean } = {}): InvoicePutBody {
  const sent = savedLines(lines);
  const types = lineVatTypes(sent, customerVat);
  const typed = taxMode !== 'none' && types.every((t) => t !== null);
  return {
    id,
    clientId: form.clientId,
    invoiceDate: form.invoiceDate,
    dueDate: opts.omitDueDate ? undefined : form.dueDate || (opts.markClearedDue ? '' : undefined),
    billingPeriodStart: form.billingPeriodStart || undefined,
    billingPeriodEnd: form.billingPeriodEnd || undefined,
    ...(taxMode === 'none' ? { taxRate: 0 } : {}),
    amountsAre: amountsAreFor(taxMode),
    notes: form.notes, // '' clears them; left out, the server would keep the old notes and Saved would be untrue
    currencyCode: form.currencyCode,
    exchangeRate: form.exchangeRate,
    projectId: form.projectId || null,
    items: sent.map((l, i) => ({
      description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
      ...(typed ? { vatType: types[i]! } : {}),
      discount: l.discount || 0,
      glAccountId: l.glAccountId || null,
      projectId: l.projectId || null,
      cc2Id: l.cc2Id || null,
      buId: l.buId || null,
      cc1Id: l.cc2Id === (l.cc2AtLoad ?? '') ? (l.cc1Id ?? null) : null,
      // A WIP line's time entry goes back with it, so the PUT (which replaces every line) keeps the link. Always sent,
      // null on an unlinked line: on a WIP invoice the server refuses a body without it (it cannot tell a removed
      // line from a client that does not know the links), and releases only entries the PUT names (useWipLines).
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
export function saveProblem({ form, lines, taxMode, customerVat }: Draft, refused: Refused, stored: StoredDates = {}): string | null {
  if (!form.clientId) return 'Select a client';
  if (lines.some((l) => l.timeEntryId && !l.description && !l.unitPrice)) return 'A time-entry line is blank: describe and price it, or remove it';
  const tooSmall = lines.find((l) => l.description && pricesToNothing(l.unitPrice));
  if (tooSmall) return pricesToNothingMessage(tooSmall.description);
  const dropped = droppedLineProblem(lines, true);
  if (dropped) return dropped;
  if (!lines.some((l) => l.description)) return 'Add at least one line item';
  const dateOrCleared = invoiceDateProblem(form, refused) ?? clearedDateProblem(form, stored);
  if (dateOrCleared) return dateOrCleared;
  // A line with no VAT type yet: the server refuses it (the rate comes from the type), so Save holds and says why.
  if (taxMode === 'none') return null;
  const sent = savedLines(lines);
  return vatTypeProblem(sent, lineVatTypes(sent, customerVat));
}

/**
 * Why autosave holds this draft back, or null: Save's refusals, plus no priced line yet, and an exchange rate the server
 * would refuse (a 400 would stop autosave for a value still being typed).
 */
export function autosaveProblem(draft: Draft, refused: Refused, stored: StoredDates = {}): string | null {
  const refusal = saveProblem(draft, refused, stored);
  if (refusal) return refusal;
  const { form, lines } = draft;
  if (!lines.some((l) => l.description && l.unitPrice > 0 && l.quantity > 0)) return 'Add a priced line';
  if (!finite(form.exchangeRate) || form.exchangeRate <= 0) return 'Check the exchange rate';
  return null;
}
