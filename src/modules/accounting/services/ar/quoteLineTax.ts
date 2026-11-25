/**
 * The VAT on a quote's lines: per-line VAT types, the contract and the pricing of a customer invoice (per-line VAT
 * programme, migration 1024), so a quote converts to an invoice of the same figures.
 *
 *   type     invoiceLineVatTypes, worded for a quote: a line `vatType` (standard, zero_rated, exempt); else the LEGACY
 *            per-line `taxRate` (what the quote form sends: one rate on every line), read as the invoice's legacy header
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
  keptQuoteTypes, legacyLinesUnchanged, matchQuoteLines, normalItem, unmatchedVatProblem, type LineMatch, type StoredQuote, type StoredQuoteVatLine,
} from './quoteEditLines';
import { typedLinesProblem } from './invoiceVatLegs';
import { LineValidationError, quoteAmountsAre } from './quoteLineChecks';
import { applyItemLineDefaults } from '../items/itemLineDefaults';
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
 * place or content: quoteEditLines, including the one line changed in place and a description match at another price)
 * keeps that stored line's item: the same line keeps its item, and the row written is the line the VAT match read
 * (itemEditLines hands items out by the raw identical key in stored order, which a case-only description change or
 * twins swapped by id would get wrong). A MATCHED line sent without an accountId keeps its stored account (the user may
 * have chosen it, and conversion credits it) unless it names a NEW item, judged against THAT matched stored line (null,
 * '' and a missing id all mean no item, as quoteEditLines compares them), with a default sales account, which it then
 * takes: read here by applyItemLineDefaults for exactly those lines, so itemEditLines' own "new item" view (the first
 * identical stored line) never decides a matched line's account. Removing an item, resending the stored one, or naming
 * one with no default account keeps the stored account. Only an accountId sent changes it, null clearing it. An
 * unmatched line: the resolved line's own. Accepted: a kept account comes from this quote's own stored rows, and
 * conversion re-checks it (assertLineAccountIds refuses one deactivated since).
 */
async function lineRefs(
  companyId: string, lines: readonly QuoteVatLineIn[], sent: readonly QuoteVatLineIn[], matches: readonly (LineMatch | null)[] | undefined,
): Promise<QuoteLineRef[]> {
  const newItemAt = lines.map((_, i) => {
    const m = matches?.[i];
    const s = sent[i];
    if (!m || s?.accountId !== undefined) return null;
    const sentItem = normalItem(s?.itemId);
    // No item named (left out, null or ''): nothing to default; else new only if it is not the matched line's.
    return sentItem !== null && sentItem !== normalItem(m.stored.itemId) ? sentItem : null;
  });
  const wanted = newItemAt.flatMap((itemId, i) => (itemId ? [{ i, itemId }] : []));
  const defaults = wanted.length === 0 ? [] : await applyItemLineDefaults(
    companyId, wanted.map((w) => ({ itemId: w.itemId, glAccountId: undefined as string | undefined })), 'sales', (k) => `items[${wanted[k]!.i}]`,
  );
  const defaultAt = new Map(wanted.map((w, k) => [w.i, ref(defaults[k]?.glAccountId)]));
  return lines.map((l, i) => {
    const m = matches?.[i];
    const s = sent[i];
    if (!m) return { itemId: ref(l.itemId), accountId: ref(l.accountId) };
    return {
      itemId: s?.itemId === undefined ? m.stored.itemId ?? null : ref(l.itemId),
      accountId: s?.accountId !== undefined ? ref(l.accountId) : defaultAt.get(i) ?? m.stored.accountId ?? null,
    };
  });
}


/**
 * An edit's lines through itemEditLines (the item check, its default account, inheritance), except that a line naming
 * the item its MATCHED stored line (quoteEditLines, the notion lineRefs uses) already carries is not a new item there:
 * it goes in as naming none, so itemEditLines neither re-checks it (an item deactivated since must not refuse the save
 * of the line that carries it, though an identical twin of another item sits first) nor defaults its account, and
 * comes back naming it; lineRefs writes its item and account. A genuinely new item is still checked and defaulted.
 */
export async function quoteEditItemLines<L extends { description: string; quantity: number; unitPrice: number; itemId?: string | null; accountId?: string; taxRate?: number | null }>(
  companyId: string, sent: readonly L[], storedQuote: StoredQuote, quoteDate: string,
): Promise<L[]> {
  const { matches } = matchQuoteLines(sent, storedQuote.lines, quoteDate);
  const own = sent.map((l, i) => normalItem(l.itemId) !== null && normalItem(l.itemId) === normalItem(matches[i]?.stored.itemId));
  const resolved = await resolveEditLineItemsAccountId(companyId, 'sales', sent.map((l, i) => (own[i] ? { ...l, itemId: undefined } : l)),
    storedQuote.lines.map((l) => ({ itemId: l.itemId ?? null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
    (i) => `items[${i}]`);
  return resolved.map((l, i) => (own[i] ? { ...l, itemId: normalItem(sent[i]!.itemId) } : l));
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
      refs: await lineRefs(companyId, args.lines, sent, matches),
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
  return { ...priced, refs: await lineRefs(companyId, args.lines, sent, matches) };
}
