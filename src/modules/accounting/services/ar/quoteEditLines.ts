/**
 * A quote edit's sent lines matched to its stored lines (quoteLineTax), for two things: the VAT type a sent line with
 * no type of its own keeps, and whether a LEGACY quote's edit left its lines exactly as stored.
 *
 * Each stored line is matched at most once. The strongest signals first, for every sent line:
 *   1. by `id` (an API caller that sends the stored line's id);
 *   2. at the same position, IDENTICAL (description, quantity, unit price: itemEditLines.identicalLineKey; and the same
 *      item when both name one) and of a COMPATIBLE rate: an unchanged line resent in its place. Between identical twins
 *      of different types its place decides only when the edit kept the number of lines (a notes-only save); with a
 *      line added or removed the twin is judged in the passes below.
 * Then, first for the lines that NAME their vatType (preferring a stored line of that type) and only then for the
 * typeless ones, so a typeless line is judged against what is actually left:
 *   3. anywhere, identical and compatible (a line moved, or a sibling deleted above it);
 *   4. at the same position, the same description (the price edited in place);
 *   5. anywhere, the same description;
 *   6. at the same position, then anywhere, the same ITEM only (the description edited too). Every description pass
 *      runs before any item-only one, so a line of the same item never takes another line's stored match.
 * Compatible: the sent line names no legacy `taxRate`, or the stored line's rate on the quote date is that rate (an
 * exempt line resent at 0 matches; a standard twin at 15% does not). Never guessed (unmatchedVatProblem, a 400 asking
 * for the `vatType` or the `id`): a typeless line whose candidates in an "anywhere" pass carry different types
 * (AMBIGUOUS, matched to none); one matching nothing while a saved zero-rated or exempt line of a compatible rate is
 * left over; one matching nothing that shares its description or item with a saved zero-rated or exempt line another
 * sent line took (a new "Fee" above the re-priced exempt "Fee": which is which cannot be told). A legacy stored line at
 * rate 0 counts as zero-rated (storedLineVatType); the caller skips these checks for a company not registered for VAT,
 * whose lines carry no type at all.
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
const sameItem = (l: SentQuoteLine, s: StoredQuoteVatLine) =>
  typeof l.itemId === 'string' && !!s.itemId && l.itemId.toLowerCase() === s.itemId.toLowerCase();
const itemsDiffer = (l: SentQuoteLine, s: StoredQuoteVatLine) => typeof l.itemId === 'string' && !!s.itemId && !sameItem(l, s);

type Fits = (l: SentQuoteLine, s: StoredQuoteVatLine) => boolean;

export function matchQuoteLines(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], date: string): LineMatches {
  const used = new Set<number>();
  const ambiguous = new Set<number>();
  const out: (LineMatch | null)[] = sent.map(() => null);
  const key = (l: { description: string; quantity: unknown; unitPrice: unknown }) => identicalLineKey(l.description, l.quantity, l.unitPrice);
  const identical = (l: SentQuoteLine, s: StoredQuoteVatLine) => key(l) === key(s) && !itemsDiffer(l, s);
  const compatible = (l: SentQuoteLine, s: StoredQuoteVatLine) => !given(l.taxRate) || Number(l.taxRate) === rateOn(s, date);
  const free = (j: number) => j >= 0 && j < stored.length && !used.has(j);
  const take = (i: number, j: number) => { used.add(j); out[i] = { stored: stored[j]!, identical: identical(sent[i]!, stored[j]!) }; };
  const open = (i: number) => !out[i] && !ambiguous.has(i);
  const named = sent.flatMap((l, i) => (given(l.vatType) ? [i] : []));
  const typeless = sent.flatMap((l, i) => (given(l.vatType) ? [] : [i]));
  const atPosition = (idx: readonly number[], fits: Fits) => idx.forEach((i) => {
    if (open(i) && free(i) && fits(sent[i]!, stored[i]!) && compatible(sent[i]!, stored[i]!)) take(i, i);
  });
  const anywhere = (idx: readonly number[], fits: Fits) => idx.forEach((i) => {
    if (!open(i)) return;
    const l = sent[i]!;
    const js = stored.flatMap((s, j) => (free(j) && fits(l, s) && compatible(l, s) ? [j] : []));
    if (js.length === 0) return;
    // A named type takes a stored line of that type if there is one; a typeless line takes one only when they agree.
    if (given(l.vatType)) { take(i, js.find((j) => typeOf(stored[j]!) === l.vatType) ?? js[0]!); return; }
    if (new Set(js.map((j) => typeOf(stored[j]!))).size > 1) { ambiguous.add(i); return; }
    take(i, js[0]!);
  });
  const all = sent.map((_, i) => i);
  all.forEach((i) => {
    const l = sent[i]!;
    const j = typeof l.id === 'string' ? stored.findIndex((s, k) => free(k) && s.id === l.id) : -1;
    if (j >= 0) take(i, j);
  });
  // Its own place decides between identical twins of different types only when no line was added or removed: with a
  // line deleted the remaining "Widget" may be either twin, and is left to be judged (and refused) below.
  const sameCount = sent.length === stored.length;
  const otherTwin = (l: SentQuoteLine, s: StoredQuoteVatLine) => stored.some((t, j) => free(j) && t !== s && identical(l, t)
    && compatible(l, t) && typeOf(t) !== typeOf(s));
  atPosition(all, (l, s) => identical(l, s) && (sameCount || !otherTwin(l, s)));
  const sameDescription: Fits = (l, s) => l.description === s.description && !itemsDiffer(l, s);
  for (const idx of [named, typeless]) {
    anywhere(idx, identical);
    atPosition(idx, sameDescription);
    anywhere(idx, sameDescription);
    atPosition(idx, sameItem);
    anywhere(idx, sameItem);
  }
  return { matches: out, ambiguous };
}

const TYPE_WORDS: Record<string, string> = { zero_rated: 'a zero-rated', exempt: 'an exempt' };
const PLAIN_WORDS: Record<string, string> = { zero_rated: 'zero-rated', exempt: 'exempt' };
const nonStandard = (s: StoredQuoteVatLine) => typeOf(s) === 'zero_rated' || typeOf(s) === 'exempt';

/**
 * Why a sent line's VAT type cannot be read from the saved quote, or null (see the header). A line naming its
 * `vatType` is never refused here. Named by position, never by description.
 */
export function unmatchedVatProblem(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], m: LineMatches, date: string): string | null {
  const takenBy = new Map(m.matches.flatMap((x, i) => (x ? [[x.stored.id, i] as const] : [])));
  for (const [i, l] of sent.entries()) {
    if (given(l.vatType) || m.matches[i]) continue;
    const ask = 'send the line\'s vatType (standard, zero_rated or exempt) or the saved line\'s id';
    if (m.ambiguous.has(i)) return `items[${i}] could be more than one saved line of different VAT types: ${ask}.`;
    const compatible = (s: StoredQuoteVatLine) => !given(l.taxRate) || Number(l.taxRate) === rateOn(s, date);
    const left = stored.find((s) => !takenBy.has(s.id) && nonStandard(s) && compatible(s));
    if (left) return `items[${i}] matches no saved line, and the quote had ${TYPE_WORDS[typeOf(left)!]} line it may be: ${ask}.`;
    const twin = stored.find((s) => takenBy.has(s.id) && nonStandard(s) && (s.description === l.description || sameItem(l, s)));
    if (twin) {
      return `items[${i}] and items[${takenBy.get(twin.id)}] are both like the saved ${PLAIN_WORDS[typeOf(twin)!]} line, `
        + `and which one it is cannot be told: ${ask}.`;
    }
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
