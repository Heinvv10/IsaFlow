/**
 * The VAT on a quote's lines: per-line VAT types, the contract and the pricing of a customer invoice (per-line VAT
 * programme, migration 1024), so a quote converts to an invoice of the same figures.
 *
 *   type     invoiceLineVatTypes, worded for a quote: a line `vatType` (standard, zero_rated, exempt); else the LEGACY
 *            per-line `taxRate` (what API callers and old drafts send; the modal sends `vatType`, or taxRate 0 for No VAT), read as the invoice's legacy header
 *            rate, line by line: the standard rate on the quote date -> standard, 0 -> zero_rated, anything else refused;
 *            on an edit the line's stored match whose type has that rate keeps it (an exempt line resent at 0 stays
 *            exempt). A `vatType` and a `taxRate` on one quote are refused, as an invoice refuses a line type with its
 *            header rate. Else, on an edit, its stored match's type (quoteEditLines: by id, else by place and content,
 *            refused, never guessed, when it cannot be read); else the default chain (the customer's zero-rated /
 *            exempt default, the item's vat_on_sales, standard).
 *   legacy   an edit of a LEGACY quote (no line typed) that leaves every line as stored (quoteEditLines
 *            .legacyLinesUnchanged: notes, customer, expiry) keeps its lines and figures as stored, whatever rate they
 *            carry (a 14% quote stays 14%): a legacy line is never re-priced. Any other edit types the whole quote.
 *   price    invoiceLineVatPricing.priceInvoiceVat: `amount` = NET, `tax_amount` = the line's VAT rounded on the line,
 *            `tax_rate` = its type's rate on the quote date; header = the sum of the lines, `tax_rate` = the highest
 *            line rate. `amountsAre` 'inclusive' stores the unit price as entered and backs the VAT out of the gross.
 *   no VAT   a company not registered for VAT writes UNTYPED lines (vat_type / tax_amount NULL, rate 0) and exclusive;
 *            a standard line or a rate above 0 is refused.
 *
 * Every refusal is raised before the first write: InvoiceLineVatRefusal / InvoiceVatNotRegisteredRefusal (registered for
 * MCP, a REST 400 with its code), LineValidationError for the mode and the total. What an invoice of the quote could not
 * approve (1 x R0.03 standard: the VAT rounds to nothing) is refused here (invoiceVatLegs.typedLinesProblem).
 */
import { InvoiceLineVatRefusal, type DocumentLineVatType, type ResolvedLineVat } from './invoiceLineVatTypes';
import { invoiceVatParties, resolveInvoiceVatFor } from './invoiceLineVatDefaults';
import { priceInvoiceVat, type AmountsAre, type VatPricedHeader, type VatPricedLine } from './invoiceLineVatPricing';
import {
  keptQuoteTypes, legacyLinesUnchanged, matchQuoteLines, normalItem, unknownIdProblem, unmatchedItemProblem, unmatchedVatProblem, type LineMatch, type StoredQuote,
  type StoredQuoteVatLine,
} from './quoteEditLines';
import { typedLinesProblem } from './invoiceVatLegs';
import { LineValidationError, quoteAmountsAre } from './quoteLineChecks';
import { applyItemLineDefaults, ItemLineRefusal } from '../items/itemLineDefaults';
import { resolveEditLineItemsAccountId } from '../items/itemEditLines';

export interface QuoteVatLineIn {
  accountId?: unknown;
  /** On an edit, the stored line's id (optional: quoteEditLines matches by position and content too). */
  id?: unknown;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: unknown;
  vatType?: unknown;
  itemId?: unknown;
}

export type { StoredQuoteVatLine };

/** The item and account each line is WRITTEN with (lineRefs). */
export interface QuoteLineRef { itemId: string | null; accountId: string | null }

/** A legacy quote kept as stored has no mode (amounts_are NULL). */
export interface PricedQuote {
  lines: VatPricedLine[];
  header: Omit<VatPricedHeader, 'amountsAre'> & { amountsAre: AmountsAre | null };
  refs: QuoteLineRef[];
}

const ref = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * The item and account each line is written with. A line sent WITHOUT an itemId that matched a stored line (by id,
 * place or content: quoteEditLines) keeps that stored line's item: the row written is the line the match read. A
 * MATCHED line sent without an accountId keeps its stored account (the user may have chosen it, and conversion credits
 * it) unless it names a NEW item (one its matched stored line does not carry; null, '' and a missing id all mean no
 * item) with a default sales account, which it then takes: quoteEditItemLines judged that item against the same
 * matched line and put its default on the resolved line. Removing an item, resending the stored one, or naming one with
 * no default account keeps the stored account. Only an accountId sent changes it, null clearing it. An unmatched line:
 * the resolved line's own. Accepted: a kept account comes from this quote's own stored rows, and conversion re-checks
 * it (assertLineAccountIds refuses one deactivated since).
 */
function lineRefs(lines: readonly QuoteVatLineIn[], sent: readonly QuoteVatLineIn[], matches: readonly (LineMatch | null)[] | undefined): QuoteLineRef[] {
  return lines.map((l, i) => {
    const m = matches?.[i];
    const s = sent[i];
    if (!m) return { itemId: ref(l.itemId), accountId: ref(l.accountId) };
    const sentItem = normalItem(s?.itemId);
    const newItem = sentItem !== null && sentItem !== normalItem(m.stored.itemId);
    return {
      itemId: s?.itemId === undefined ? m.stored.itemId ?? null : ref(l.itemId),
      accountId: s?.accountId !== undefined ? ref(l.accountId) : (newItem ? ref(l.accountId) : null) ?? m.stored.accountId ?? null,
    };
  });
}


/**
 * An edit's lines, items judged against the line's OWN matched stored line (quoteEditLines, by id, place or content).
 * Refused first: an id this quote does not hold (unknownIdProblem), and a standard-only line whose item and account
 * cannot be read (unmatchedItemProblem). A line with no itemId inherits nothing here (no identical-line pool: an
 * unmatched line is a new line, with no item unless it names one); a matched one keeps its stored item in lineRefs. A
 * NAMED item that line already carries is not re-checked (deactivated since must not refuse the save of the line that
 * carries it); any other, a twin carrying it or not, is NEW and checked (this company's, active, its default account
 * active) by applyItemLineDefaults, which also gives it its default account when the line names none.
 */
export async function quoteEditItemLines<L extends { description: string; quantity: number; unitPrice: number; itemId?: string | null; accountId?: string; taxRate?: number | null }>(
  companyId: string, sent: readonly L[], storedQuote: StoredQuote, quoteDate: string,
): Promise<L[]> {
  const matched = matchQuoteLines(sent, storedQuote.lines, quoteDate);
  const problem = unknownIdProblem(sent, matched) ?? unmatchedItemProblem(sent, matched);
  if (problem) throw new ItemLineRefusal(problem);
  const named = sent.map((l) => normalItem(l.itemId));
  const isNew = named.map((n, i) => n !== null && n !== normalItem(matched.matches[i]?.stored.itemId));
  // No identical-line pool: a line takes an item only from its match (lineRefs) or by naming one; this pass refuses a
  // non-string itemId and reads '' as no item.
  const resolved = await resolveEditLineItemsAccountId(companyId, 'sales', sent.map((l, i) => (named[i] !== null ? { ...l, itemId: undefined } : l)),
    [], (i) => `items[${i}]`);
  const wanted = isNew.flatMap((n, i) => (n ? [i] : []));
  const checked = wanted.length === 0 ? [] : await applyItemLineDefaults(
    companyId, wanted.map((i) => ({ itemId: named[i]!, glAccountId: sent[i]!.accountId })), 'sales', (k) => `items[${wanted[k]}]`,
  );
  return resolved.map((l, i) => {
    if (named[i] === null) return l;
    const k = wanted.indexOf(i);
    return { ...l, itemId: named[i]!, accountId: k >= 0 ? checked[k]!.glAccountId ?? sent[i]!.accountId : sent[i]!.accountId };
  });
}

const given = (v: unknown): boolean => v !== undefined && v !== null;
type QuoteVatParties = Awaited<ReturnType<typeof invoiceVatParties>>;

/** Each line's type (or untyped for a non-vendor): the invoice contract, the legacy per-line rate read as a header rate. */
async function resolveQuoteVat(
  companyId: string, parties: QuoteVatParties, quoteDate: string, lines: readonly QuoteVatLineIn[], kept: readonly (DocumentLineVatType | null)[] | undefined,
): Promise<ResolvedLineVat> {
  // One resolution per legacy rate (and one for the lines with none): each group's rate is that group's header rate.
  const groups = new Map<number | null, number[]>();
  lines.forEach((l, i) => {
    const rate = given(l.taxRate) ? Number(l.taxRate) : null;
    groups.set(rate, [...(groups.get(rate) ?? []), i]);
  });
  const types: DocumentLineVatType[] = [];
  let typed = true;
  for (const [rate, idx] of groups) {
    const vat = await resolveInvoiceVatFor(companyId, parties, {
      invoiceDate: quoteDate, headerTaxRate: rate ?? undefined, document: 'quote', label: (j) => `items[${idx[j]}]`,
      lines: idx.map((i) => ({ vatType: lines[i]!.vatType, itemId: lines[i]!.itemId })),
      kept: kept ? idx.map((i) => kept[i] ?? null) : undefined,
    });
    if (!vat.typed) typed = false;
    else vat.types.forEach((t, j) => { types[idx[j]!] = t; });
  }
  return typed ? { typed: true, types } : { typed: false };
}

/**
 * The quote's lines and header as stored (see the header). `stored` = the quote's current lines on an edit. Throws
 * before any write; the lines' quantity and price are already W1-checked (quoteLineChecks.assertValidLines).
 */
export async function priceQuoteLines(companyId: string, args: {
  clientId: string | null; quoteDate: string; lines: readonly QuoteVatLineIn[]; amountsAre: unknown; stored?: StoredQuote;
  /** An edit's lines as SENT, before itemEditLines gave a line an identical stored line's item: what is matched. */
  sent?: readonly QuoteVatLineIn[];
}): Promise<PricedQuote> {
  const amountsAre = quoteAmountsAre(args.amountsAre);
  if (args.lines.some((l) => given(l.vatType)) && args.lines.some((l) => given(l.taxRate))) {
    throw new InvoiceLineVatRefusal('Send a vatType on each line or a taxRate, not both: the rate comes from the VAT type.');
  }
  // Matched on the lines as sent: an item inherited from "the first identical stored line" is itself a guess.
  const sent = args.sent ?? args.lines;
  const matched = args.stored ? matchQuoteLines(sent, args.stored.lines, args.quoteDate) : undefined;
  const matches = matched?.matches;
  if (args.stored && matches && legacyLinesUnchanged(sent, args.stored.lines, matches, args.amountsAre)) {
    const { subtotal, tax, total, taxRate } = args.stored;
    return {
      lines: matches.map((m) => ({ qty: m!.stored.quantity, price: m!.stored.unitPrice, amount: m!.stored.amount, taxAmount: null, vatType: null, taxRate: m!.stored.taxRate })),
      header: { subtotal, tax, total, taxRate, amountsAre: null },
      refs: lineRefs(args.lines, sent, matches),
    };
  }
  const parties = await invoiceVatParties(companyId, args.clientId);
  // A line whose saved type cannot be read (quoteEditLines: a zero-rated / exempt quote edited other than in place):
  // asked, not guessed. Not for a company not registered for VAT: its lines carry no type at all.
  const unread = parties.registered && matched ? unmatchedVatProblem(sent, matched) : null;
  if (unread) throw new InvoiceLineVatRefusal(unread);
  const vat = await resolveQuoteVat(companyId, parties, args.quoteDate, args.lines, matches && keptQuoteTypes(matches));
  const priced = priceInvoiceVat(args.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })), vat, args.quoteDate, amountsAre);
  // numeric(15,2): priceInvoiceVat leaves a line past the column unpriced and carries it into the total.
  if (!(Math.abs(priced.header.total) < 1e13)) throw new LineValidationError('The quote total is too large');
  const problem = typedLinesProblem(
    priced.lines.map((l) => ({ amount: l.amount, taxAmount: l.taxAmount, vatType: l.vatType, glAccountId: null, projectId: null })),
    { subtotal: priced.header.subtotal, taxAmount: priced.header.tax, totalAmount: priced.header.total, invoiceDate: args.quoteDate, amountsAre },
  );
  if (problem) throw new InvoiceLineVatRefusal(`This quote could not be invoiced as priced: ${problem}`);
  return { ...priced, refs: lineRefs(args.lines, sent, matches) };
}
