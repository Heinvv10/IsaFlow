/**
 * A quote edit's sent lines matched to its stored lines (quoteLineTax), for two things: the VAT type a sent line with
 * no type of its own keeps, and whether a LEGACY quote's edit left its lines exactly as stored.
 *
 * Each stored line is matched at most once, in passes over all the sent lines (so a later pass never takes a line an
 * earlier one could claim):
 *   1. by `id` (an API caller that sends the stored line's id);
 *   2. at the same position, identical (description, quantity, unit price: itemEditLines.identicalLineKey) and of a
 *      COMPATIBLE rate;
 *   3. anywhere, identical and compatible (a line moved, or a sibling deleted above it);
 *   4. at the same position, compatible (the line edited in place: its price changed).
 * Compatible: the sent line names no legacy `taxRate`, or the stored line's rate on the quote date is that rate (an
 * exempt line resent at 0 matches; a standard twin at 15% does not). Two identical lines sent with neither a type nor
 * a rate cannot be told apart: the first stored one is taken.
 *
 * Pure.
 */
import { isRatedDate } from '@/lib/vat/standardRate';
import { identicalLineKey } from '../items/itemEditLines';
import { vatRatePctOn } from '../shared/vatTypes';
import { storedLineVatType, type DocumentLineVatType } from './invoiceLineVatTypes';
import type { Quote } from './quoteService';

/** A stored line as getQuote maps it. */
export interface StoredQuoteVatLine {
  id: string; description: string; quantity: number; unitPrice: number; taxRate: number;
  /** The line's NET. */
  amount: number;
  taxAmount: number | null; vatType: string | null;
}

/** The quote being edited: its lines and header figures as stored. */
export interface StoredQuote { lines: readonly StoredQuoteVatLine[]; subtotal: number; tax: number; total: number; taxRate: number }

/** getQuote's quote as an edit reads it. */
export function storedQuoteOf(q: Pick<Quote, 'subtotal' | 'taxAmount' | 'total' | 'taxRate' | 'lines'>): StoredQuote {
  return {
    subtotal: q.subtotal, tax: q.taxAmount, total: q.total, taxRate: q.taxRate,
    lines: (q.lines ?? []).map((l) => ({
      id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, amount: l.lineTotal,
      taxAmount: l.taxAmount, vatType: l.vatType,
    })),
  };
}

export interface SentQuoteLine { id?: unknown; description: string; quantity: number; unitPrice: number; taxRate?: unknown; vatType?: unknown }

export interface LineMatch { stored: StoredQuoteVatLine; identical: boolean }

const given = (v: unknown): boolean => v !== undefined && v !== null;

/** The rate a stored line carries on `date`: a legacy line its own, a typed one its type's. */
function rateOn(s: StoredQuoteVatLine, date: string): number {
  if (s.vatType == null) return Number(s.taxRate);
  const t = storedLineVatType(s.vatType, s.taxRate);
  return t && isRatedDate(date) ? vatRatePctOn(t, date) : Number.NaN;
}

export function matchQuoteLines(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], date: string): (LineMatch | null)[] {
  const used = new Set<number>();
  const out: (LineMatch | null)[] = sent.map(() => null);
  const key = (l: { description: string; quantity: unknown; unitPrice: unknown }) => identicalLineKey(l.description, l.quantity, l.unitPrice);
  const identical = (l: SentQuoteLine, s: StoredQuoteVatLine) => key(l) === key(s);
  const compatible = (l: SentQuoteLine, s: StoredQuoteVatLine) => !given(l.taxRate) || Number(l.taxRate) === rateOn(s, date);
  const take = (i: number, j: number) => { used.add(j); out[i] = { stored: stored[j]!, identical: identical(sent[i]!, stored[j]!) }; };
  const pass = (pick: (l: SentQuoteLine, i: number) => number) => sent.forEach((l, i) => {
    if (out[i]) return;
    const j = pick(l, i);
    if (j >= 0) take(i, j);
  });
  const free = (j: number) => j >= 0 && j < stored.length && !used.has(j);
  pass((l) => stored.findIndex((s, j) => free(j) && typeof l.id === 'string' && s.id === l.id));
  pass((l, i) => (free(i) && identical(l, stored[i]!) && compatible(l, stored[i]!) ? i : -1));
  pass((l) => stored.findIndex((s, j) => free(j) && identical(l, s) && compatible(l, s)));
  pass((l, i) => (free(i) && compatible(l, stored[i]!) ? i : -1));
  return out;
}

/** The type each sent line keeps from its match (storedLineVatType: a legacy line reads standard above 0, else zero_rated). */
export const keptQuoteTypes = (matches: readonly (LineMatch | null)[]): (DocumentLineVatType | null)[] =>
  matches.map((m) => (m ? storedLineVatType(m.stored.vatType, m.stored.taxRate) : null));

/**
 * Whether a LEGACY quote's edit leaves every line as stored: the same number of lines, each identical to its match,
 * naming no type and no rate other than the stored one, and the mode not turned inclusive. Such an edit (notes, the
 * customer, the expiry) keeps the stored lines and figures: a legacy line is never re-priced.
 */
export function legacyLinesUnchanged(
  sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], matches: readonly (LineMatch | null)[], amountsAre: unknown,
): boolean {
  if (stored.length === 0 || stored.some((s) => s.vatType != null || s.taxAmount != null)) return false;
  if (sent.length !== stored.length || amountsAre === 'inclusive') return false;
  return sent.every((l, i) => {
    const m = matches[i];
    return !!m && m.identical && !given(l.vatType) && (!given(l.taxRate) || Number(l.taxRate) === Number(m.stored.taxRate));
  });
}
