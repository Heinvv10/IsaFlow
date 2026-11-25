/**
 * A quote edit's sent lines matched to its stored lines (quoteLineTax), for two things: the VAT type a sent line with
 * no type of its own keeps, and whether a LEGACY quote's edit left its lines exactly as stored.
 *
 * A line with an `id` takes that stored line. Otherwise one rule decides, by what the saved quote holds:
 *
 *   ONLY STANDARD lines saved (the VAT type is not at risk; the item and account are), round 12's STRUCTURAL rule: a
 *     line with no id takes a stored line's item and account ONLY (a) at its OWN place, on the same description
 *     (trimmed, case-insensitive), or renamed there naming the place's own item; or (b) by a description UNIQUE among
 *     the stored lines and among the sent lines. Same-description stored twins all carrying the same item and account
 *     are interchangeable and pair freely. Any other line whose description has stored twins of different items or
 *     accounts is AMBIGUOUS, and refused (unmatchedVatProblem: a 400 asking for the saved line's id, or an explicit
 *     itemId and accountId), as is a line at its place naming an item that ANOTHER same-description twin carries (moved
 *     or re-itemed: it cannot be told). A line with no stored line of its description is a new line.
 *   A ZERO-RATED or EXEMPT line saved (a legacy 0% line counts): a typeless line inherits a saved type ONLY from a
 *     POSITIONAL resend: the same number of lines, each identical to the saved line in its own place and of a
 *     compatible rate, except at most one changed in place (its price, quantity, or its description or its item, not
 *     both: a line whose description AND item changed is another line). A line sent with its `id` takes its own place
 *     and does not count as the change. Any other shape (a line added, removed or moved, two changed, twins shifted,
 *     a legacy rate sent that is not the saved line's) matches nothing by content, and every line with neither `id`
 *     nor `vatType` (nor a legacy rate above 0, which types it standard by itself) is refused (unmatchedVatProblem: a
 *     400 asking for its `vatType` or the saved line's `id`). Nothing is guessed across types, identical twins of
 *     different types included.
 * A legacy `taxRate` is compatible with a stored line only at that line's rate on the quote date (a legacy line: its
 * own rate), so a rate the caller changed is never "unchanged", however the line matched (an id match keeps the line's
 * identity, and the rate sent then types it by the legacy header rule). Ids compare case-insensitively. Policy: the
 * one change in place that keeps its description but names another item is the same line, and keeps its type. The caller skips the
 * refusal for a company not registered for VAT, whose lines carry no type at all.
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
  id: string; description: string; quantity: number; unitPrice: number; taxRate: number; itemId?: string | null; accountId?: string | null;
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
      id: l.id, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, amount: l.lineTotal, itemId: l.itemId, accountId: l.accountId,
      taxAmount: l.taxAmount, vatType: l.vatType,
    })),
  };
}

export interface SentQuoteLine {
  id?: unknown; description: string; quantity: number; unitPrice: number; taxRate?: unknown; vatType?: unknown; itemId?: unknown; accountId?: unknown;
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
  /** Standard-only: lines whose item and account cannot be told (see the header); refused. */
  ambiguous: number[];
  /** The saved quote holds a zero-rated or exempt line (see the header). */
  sensitive: boolean;
  /** Sensitive only: the edit is a positional resend, so its lines matched their places. */
  positional: boolean;
}

const typeOf = (s: StoredQuoteVatLine) => storedLineVatType(s.vatType, s.taxRate);
const nonStandard = (s: StoredQuoteVatLine) => typeOf(s) === 'zero_rated' || typeOf(s) === 'exempt';
/** A description as compared: trimmed and lower-cased; a missing or non-string one (a bare API body) reads as empty. */
const descOf = (d: unknown) => (typeof d === 'string' ? d.trim().toLowerCase() : '');
const idOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);
/** An item id as compared: lower-cased; null, '' and a missing one all mean no item. Shared with quoteLineTax.lineRefs. */
export const normalItem = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v.toLowerCase() : null);
const itemOf = (l: SentQuoteLine): string | null => normalItem(l.itemId);
const sameItem = (l: SentQuoteLine, s: StoredQuoteVatLine) => itemOf(l) !== null && !!s.itemId && itemOf(l) === s.itemId.toLowerCase();
const key = (l: { description: string; quantity: unknown; unitPrice: unknown }) => identicalLineKey(descOf(l.description), l.quantity, l.unitPrice);
/**
 * Whether the item a sent line names is not the stored line's: another item, one added where it had none, or one
 * removed (`itemId` null or ''). An `itemId` left out keeps the stored item (quoteLineTax.lineRefs writes the matched
 * stored line's item), so it is no change.
 */
const itemChanged = (l: SentQuoteLine, s: StoredQuoteVatLine) => l.itemId !== undefined && itemOf(l) !== (s.itemId ? s.itemId.toLowerCase() : null);
const identical = (l: SentQuoteLine, s: StoredQuoteVatLine) => key(l) === key(s) && !itemChanged(l, s);
/**
 * As identical, for the positional resend of a typed quote (round 6 decision): an item ADDED where the stored line had
 * none is no change there (the line's type is kept anyway); an item changed or removed still is. The legacy
 * "unchanged" decision uses identical, where an added item is a change (the line is re-priced).
 */
const identicalInPlace = (l: SentQuoteLine, s: StoredQuoteVatLine) => key(l) === key(s) && !(itemChanged(l, s) && !!s.itemId);
/** The same line by its description, whatever item it now names (the policy: the same description is the same line). */
const sameDescription = (l: SentQuoteLine, s: StoredQuoteVatLine) => descOf(l.description) === descOf(s.description);

/** See the header: the same count, every line of a compatible rate, identical in its place but at most one changed in place. */
function positionalResend(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], compatible: Fits): boolean {
  if (sent.length !== stored.length) return false;
  if (sent.some((l, i) => idOf(l.id) !== null && idOf(l.id) !== idOf(stored[i]!.id))) return false;
  if (sent.some((l, i) => !compatible(l, stored[i]!))) return false;
  const changed = sent.flatMap((l, i) => (idOf(l.id) === null && !identicalInPlace(l, stored[i]!) ? [i] : []));
  // The one change keeps its description or its item; both changed is another line, never this place's type.
  if (changed.length === 0) return true;
  const [c] = changed;
  return changed.length === 1 && (descOf(sent[c!]!.description) === descOf(stored[c!]!.description) || sameItem(sent[c!]!, stored[c!]!));
}

type Fits = (l: SentQuoteLine, s: StoredQuoteVatLine) => boolean;

export function matchQuoteLines(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], date: string): LineMatches {
  const used = new Set<number>();
  const out: (LineMatch | null)[] = sent.map(() => null);
  const compatible = (l: SentQuoteLine, s: StoredQuoteVatLine) => !given(l.taxRate) || Number(l.taxRate) === rateOn(s, date);
  const free = (j: number) => j >= 0 && j < stored.length && !used.has(j);
  // The ONE place a match is made, by every path (id, positional, the passes): `identical` (what "unchanged" reads) also
  // needs a compatible rate, so a line sent by id at another legacy rate keeps its identity but is never unchanged.
  const take = (i: number, j: number) => {
    used.add(j);
    out[i] = { stored: stored[j]!, identical: identical(sent[i]!, stored[j]!) && compatible(sent[i]!, stored[j]!) };
  };
  sent.forEach((l, i) => {
    const j = idOf(l.id) !== null ? stored.findIndex((s, k) => free(k) && idOf(s.id) === idOf(l.id)) : -1;
    if (j >= 0) take(i, j);
  });
  const sensitive = stored.some(nonStandard);
  if (sensitive) {
    const positional = positionalResend(sent, stored, compatible);
    if (positional) sent.forEach((_, i) => { if (!out[i]) take(i, i); });
    return { matches: out, sensitive, positional, ambiguous: [] };
  }
  return { matches: out, sensitive, positional: false, ambiguous: standardOnly(sent, stored, out, free, take, compatible) };
}

/** Item and account by the standard-only structural rule (see the header); returns the ambiguous lines. */
function standardOnly(sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], out: readonly (LineMatch | null)[],
  free: (j: number) => boolean, take: (i: number, j: number) => void, compatible: Fits): number[] {
  const ambiguous: number[] = [];
  const twinsOf = (l: SentQuoteLine) => stored.flatMap((s, j) => (sameDescription(l, s) ? [j] : []));
  const itemAccount = (s: StoredQuoteVatLine) => `${normalItem(s.itemId)}|${s.accountId ?? ''}`;
  // (a) At its own place: the same description, or renamed there naming the place's own item. A line naming an item that
  // another same-description twin carries is not resolved by its place (moved, or re-itemed: it cannot be told).
  sent.forEach((l, i) => {
    if (out[i] || !free(i) || !compatible(l, stored[i]!)) return;
    const here = stored[i]!;
    const named = itemOf(l);
    if (named !== null && named !== normalItem(here.itemId) && sameDescription(l, here)
      && twinsOf(here).some((j) => j !== i && normalItem(stored[j]!.itemId) === named)) { ambiguous.push(i); return; }
    if (sameDescription(l, here) || (named !== null && named === normalItem(here.itemId))) take(i, i);
  });
  // (b) A description unique among the stored lines and the sent lines; interchangeable twins pair freely; else ambiguous.
  sent.forEach((l, i) => {
    if (out[i] || ambiguous.includes(i)) return;
    const js = twinsOf(l);
    if (js.length === 0) return; // a new line
    const unique = js.length === 1 && sent.filter((o) => descOf(o.description) === descOf(l.description)).length === 1;
    if (unique || new Set(js.map((j) => itemAccount(stored[j]!))).size === 1) {
      const j = js.find((k) => free(k) && compatible(l, stored[k]!));
      if (j !== undefined) take(i, j);
      return;
    }
    ambiguous.push(i);
  });
  return ambiguous;
}

/**
 * Why a sent line's VAT type cannot be read from the saved quote, or null (see the header): the saved quote holds a
 * zero-rated or exempt line and the edit is not a positional resend, so every line with neither `id` nor `vatType`
 * (nor a legacy rate above 0) is asked for one. Named by position, never by description.
 */
export function unmatchedVatProblem(sent: readonly SentQuoteLine[], m: LineMatches): string | null {
  if (!m.sensitive || m.positional) return null;
  const i = sent.findIndex((l, k) => !given(l.vatType) && !m.matches[k] && !(given(l.taxRate) && Number(l.taxRate) !== 0));
  if (i < 0) return null;
  return `items[${i}]: this quote has zero-rated or exempt lines, and the edit does not resend them in their places (a line `
    + 'was added, removed or moved, more than one changed, one changed both its description and its item, or a rate changed; '
    + 'identical lines of different types are not told apart either), '
    + 'so the line\'s VAT type cannot be read from the saved quote: send its vatType (standard, zero_rated or exempt) or the saved line\'s id.';
}

/**
 * Why a sent line's item and account cannot be read from a standard-only saved quote, or null (see the header): the
 * first ambiguous line that names neither an itemId nor an accountId of its own. Named by position, never by description.
 */
export function unmatchedItemProblem(sent: readonly SentQuoteLine[], m: LineMatches): string | null {
  const i = m.ambiguous.find((k) => sent[k]!.itemId === undefined || sent[k]!.accountId === undefined);
  if (i === undefined) return null;
  return `items[${i}]: the saved quote has more than one line of this description with different items or accounts, and this `
    + 'line is not in its saved place (or names an item another of them carries), so which one it is cannot be told: '
    + 'send the saved line\'s id, or name its itemId and accountId.';
}

/** The type each sent line keeps from its match (storedLineVatType: a legacy line reads standard above 0, else zero_rated). */
export const keptQuoteTypes = (matches: readonly (LineMatch | null)[]): (DocumentLineVatType | null)[] =>
  matches.map((m) => (m ? typeOf(m.stored) : null));

/**
 * Whether a LEGACY quote's edit leaves every line as stored: the same number of lines, each identical to its match,
 * naming no type, no rate other than the stored one and no item other than the stored one (an item added, changed or
 * removed is a change: the line is re-priced), and the mode not turned inclusive. Such an edit (notes, the customer,
 * the expiry) keeps the stored lines and figures: a legacy line left as it is is never re-priced, not when the quote's
 * date moves nor when the company's VAT registration changes (documented rule; it is re-priced once its lines change).
 */
export function legacyLinesUnchanged(
  sent: readonly SentQuoteLine[], stored: readonly StoredQuoteVatLine[], matches: readonly (LineMatch | null)[], amountsAre: unknown,
): boolean {
  if (stored.length === 0 || stored.some((s) => s.vatType != null || s.taxAmount != null)) return false;
  if (sent.length !== stored.length || amountsAre === 'inclusive') return false;
  return sent.every((l, i) => {
    const m = matches[i];
    // `identical` includes a compatible rate (matchQuoteLines.take), whatever matched the line: id, place or content.
    return !!m && m.identical && !given(l.vatType);
  });
}
