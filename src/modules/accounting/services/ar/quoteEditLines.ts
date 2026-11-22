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
 *   4. at the same position, compatible, and the SAME line: its description or its item (the price edited in place);
 *   5. anywhere, compatible, the same description or item (edited, and moved or a sibling deleted above it).
 * Compatible: the sent line names no legacy `taxRate`, or the stored line's rate on the quote date is that rate (an
 * exempt line resent at 0 matches; a standard twin at 15% does not). Never guessed: a sent line with no `vatType` whose
 * candidates in a pass carry different types (twins "Widget" standard and exempt, sent with no id or rate) is
 * AMBIGUOUS and matched to none, and `unmatchedVatProblem` refuses it, as it refuses a typeless line matching nothing
 * while a saved zero-rated or exempt line it may be is left over: the caller is asked for the `vatType` or the `id`.
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
  id: string; description: string; quantity: number; unitPrice: number; taxRate: number; itemId?: string | null;
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
      id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, amount: l.lineTotal, itemId: l.itemId,
      taxAmount: l.taxAmount, vatType: l.vatType,
    })),
  };
}

export interface SentQuoteLine {
  id?: unknown; description: string; quantity: number; unitPrice: number; taxRate?: unknown; vatType?: unknown; itemId?: unknown;
}

export interface LineMatch { stored: StoredQuoteVatLine; identical: boolean }

const given = (v: unknown): boolean => v !== undefined && v !== null;

/** The rate a stored line carries on `date`: a legacy line its own, a typed one its type's. */
function rateOn(s: StoredQuoteVatLine, date: string): number {
  if (s.vatType == null) return Number(s.taxRate);
  const t = storedLineVatType(s.vatType, s.taxRate);
  return t && isRatedDate(date) ? vatRatePctOn(t, date) : Number.NaN;
}

export interface LineMatches {
  matches: (LineMatch | null)[];
  /** Sent lines whose candidates carry different VAT types: matched to none (see the header). */
  ambiguous: Set<number>;
}

const typeOf = (s: StoredQuoteVatLine) => storedLineVatType(s.vatType, s.taxRate);

export function matchQuoteLines(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], date: string): LineMatches {
  const used = new Set<number>();
  const ambiguous = new Set<number>();
  const out: (LineMatch | null)[] = sent.map(() => null);
  const key = (l: { description: string; quantity: unknown; unitPrice: unknown }) => identicalLineKey(l.description, l.quantity, l.unitPrice);
  const identical = (l: SentQuoteLine, s: StoredQuoteVatLine) => key(l) === key(s);
  const sameLine = (l: SentQuoteLine, s: StoredQuoteVatLine) => l.description === s.description
    || (typeof l.itemId === 'string' && !!s.itemId && l.itemId.toLowerCase() === s.itemId.toLowerCase());
  const compatible = (l: SentQuoteLine, s: StoredQuoteVatLine) => !given(l.taxRate) || Number(l.taxRate) === rateOn(s, date);
  const free = (j: number) => j >= 0 && j < stored.length && !used.has(j);
  /** The free stored lines `fits`, or null when the sent line names no type and they carry different ones. */
  const candidates = (l: SentQuoteLine, i: number, fits: (s: StoredQuoteVatLine) => boolean): number[] | null => {
    const js = stored.flatMap((s, j) => (free(j) && fits(s) ? [j] : []));
    if (!given(l.vatType) && new Set(js.map((j) => typeOf(stored[j]!))).size > 1) { ambiguous.add(i); return null; }
    return js;
  };
  const pass = (pick: (l: SentQuoteLine, i: number) => number) => sent.forEach((l, i) => {
    if (out[i] || ambiguous.has(i)) return;
    const j = pick(l, i);
    if (j >= 0) { used.add(j); out[i] = { stored: stored[j]!, identical: identical(l, stored[j]!) }; }
  });
  const atPosition = (fits: (l: SentQuoteLine, s: StoredQuoteVatLine) => boolean) => (l: SentQuoteLine, i: number) => {
    const js = candidates(l, i, (s) => fits(l, s));
    return js?.includes(i) ? i : -1;
  };
  const anywhere = (fits: (l: SentQuoteLine, s: StoredQuoteVatLine) => boolean) => (l: SentQuoteLine, i: number) =>
    candidates(l, i, (s) => fits(l, s))?.[0] ?? -1;
  const same = (l: SentQuoteLine, s: StoredQuoteVatLine) => identical(l, s) && compatible(l, s);
  const edited = (l: SentQuoteLine, s: StoredQuoteVatLine) => sameLine(l, s) && compatible(l, s);
  pass((l) => stored.findIndex((s, j) => free(j) && typeof l.id === 'string' && s.id === l.id));
  pass(atPosition(same));
  pass(anywhere(same));
  pass(atPosition(edited));
  pass(anywhere(edited));
  return { matches: out, ambiguous };
}

const TYPE_WORDS: Record<string, string> = { zero_rated: 'a zero-rated', exempt: 'an exempt' };

/**
 * Why a sent line's VAT type cannot be read from the saved quote, or null (see the header): it is ambiguous, or it
 * matched nothing while a saved zero-rated or exempt line of a compatible rate is left unmatched. A line naming its
 * `vatType` is never refused here. Named by position, never by description.
 */
export function unmatchedVatProblem(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], m: LineMatches, date: string): string | null {
  const taken = new Set(m.matches.flatMap((x) => (x ? [x.stored.id] : [])));
  for (const [i, l] of sent.entries()) {
    if (given(l.vatType) || m.matches[i]) continue;
    const ask = 'send the line\'s vatType (standard, zero_rated or exempt) or the saved line\'s id';
    if (m.ambiguous.has(i)) return `items[${i}] could be more than one saved line of different VAT types: ${ask}.`;
    const left = stored.find((s) => !taken.has(s.id) && s.vatType != null && (typeOf(s) === 'zero_rated' || typeOf(s) === 'exempt')
      && (!given(l.taxRate) || Number(l.taxRate) === rateOn(s, date)));
    if (left) return `items[${i}] matches no saved line, and the quote had ${TYPE_WORDS[typeOf(left)!]} line it may be: ${ask}.`;
  }
  return null;
}

/** The type each sent line keeps from its match (storedLineVatType: a legacy line reads standard above 0, else zero_rated). */
export const keptQuoteTypes = (matches: readonly (LineMatch | null)[]): (DocumentLineVatType | null)[] =>
  matches.map((m) => (m ? typeOf(m.stored) : null));

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
    // A match is of a compatible rate already: a legacy line's own (matchQuoteLines.rateOn).
    return !!m && m.identical && !given(l.vatType);
  });
}
