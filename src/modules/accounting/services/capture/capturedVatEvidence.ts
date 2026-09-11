/**
 * Does a draft raised from a captured document carry the VAT that document
 * shows (K-072 r30–r33)?
 *
 * The capture builders used to INVENT 15/115 of the total as a draft's VAT —
 * when the extraction read no VAT at all, and also when it read the VAT but not
 * the net (a till slip printing `VAT 0.00`, or `VAT 13.04`, got 117.42 or
 * 18.26). The builders no longer invent it, but a draft created before that
 * change still carries the invented figure, and the MCP tools that post a draft
 * by id (`approve_supplier_invoice`, `bulk_approve_supplier_invoices`,
 * `post_journal`) have no way to know it was never on the document.
 *
 * So an agent may post such a draft only when its VAT equals, to the cent, the
 * VAT the captured document EVIDENCES: the VAT read (`extracted_data.vatAmount`),
 * or — when none was read — 0, but only on a POSITIVE signal that the document
 * is not a VAT document (round 34), and round 35 narrows that signal to the one
 * statement that can carry it: the SUPPLIER's registration status, standing as
 * a line of its own (`Not VAT registered`, `We are not registered for VAT.`,
 * `Ons is nie BTW-geregistreer nie`). Round 34 matched mid-sentence, so `VAT is
 * not applicable on the call-out fee` — about one item, on a page charging VAT
 * the reader missed — evidenced none. And it fails closed on everything else:
 * any OTHER line that speaks of tax (a tax word, OCR damage included, `incl`,
 * 15%) or a VAT-number-shaped token (OCR-damaged digits included) refuses. A
 * phrase the list lacks costs a refusal, never an approval. The supplier master
 * is not a signal: `suppliers.vat_number` NULL means "not captured".
 * A person approving in the attended workflow is not affected.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { mealsVatNeedsAPerson } from '@/modules/accounting/services/bank/receiptToJournalService';
import { printedFigures } from '@/modules/accounting/services/core/ocrPrintedFigures';

const VAT = String.raw`(?:V\.?\s?A\.?\s?T\.?|B\.?\s?T\.?\s?W\.?)`;
/** The supplier's own registration status, as a whole line: a statement about an item or a customer is not one. */
const DECLARATION = new RegExp(String.raw`^\s*(?:(?:we|this\s+(?:supplier|vendor|business|company)|the\s+supplier|supplier|vendor|ons)\s+(?:is|are)\s+)?`
  + String.raw`(?:not\s+(?:a\s+)?${VAT}[\s-]*registered(?:\s+(?:vendor|supplier|business|company))?|not\s+registered\s+for\s+${VAT}`
  + String.raw`|non[\s-]*${VAT}(?:[\s-]*registered)?[\s-]+(?:vendor|supplier|business|company)`
  + String.raw`|nie\s+(?:vir\s+)?${VAT}[\s-]*geregistreer\s+nie|nie\s+geregistreer\s+vir\s+${VAT}\s+nie)\s*[.!]?\s*$`, 'i');
/**
 * Any other mention of tax, fail closed (r35–r37). A word CONTAINING a tax root
 * is a mention, glued on either side (`TotalVAT`, `VATAMT`, `TaxAmt`,
 * `BTWbedrag`, `VATR130.43`), unless it is one of a few ordinary words; so is a
 * dotted, spaced or OCR-damaged spelling (`V.A.T.`, `V A T`, `VAl`, `V4T`,
 * `8TW`, `V/AT`, `T.A.X.`), `incl…`, or the 15% rate with decimals.
 */
const TAX_ROOT = /vat|btw|tax|belasting/i;
const ORDINARY = new Set(['private', 'privately', 'privatised', 'privatisation', 'renovate', 'renovated', 'renovation', 'renovations',
  'elevator', 'elevators', 'activate', 'activated', 'activation', 'motivate', 'motivated', 'motivation', 'cultivate', 'cultivation',
  'observatory', 'conservation', 'conservatory', 'reservation', 'reservations', 'preservation', 'preservative', 'innovation',
  'innovative', 'derivative', 'taxi', 'taxis', 'syntax']);
const TAX_SPELLING = new RegExp(String.raw`V[.\s_:-]+A[.\s_:-]*T|VA[.\s_:-]+T|B[.\s_:-]+T[.\s_:-]*W|BT[.\s_:-]+W|\\?V?\s?\/\s?A\s?T|T\.A\.X|value\s*added`
  + String.raw`|(?<![A-Za-z])(?:V\.?\s?(?:4\.?\s?[T7lI1]|A\.?\s?[7lI1])|8\.?\s?T\.?\s?W)(?![A-Za-z])|(?<![A-Za-z])incl|(?<![\d.,])15(?:[.,]\d+)?\s*(?:%|persent)`, 'i');
/** OCR spellings only in capitals (r38): `WAT` for VAT, `Tx`/`TX` for tax — Afrikaans `wat` ("which") is no mention. */
const TAX_OCR_CAPS = /(?<![A-Za-z])(?:WAT|Tx|TX)(?![A-Za-z])/;
/**
 * `Wat`/`wAT`/`UAT`/`W.A.T` in ANY case where the line is shaped like a tax
 * label (r39): the word followed only by a separator and an amount, a `%`, an
 * `R` or "amount". Afrikaans prose (`Werk wat gedoen is 1000.00`) still passes:
 * there the word is followed by words, not a figure.
 */
const WAT_LABEL = /(?<![A-Za-z])[WU]\.?\s?A\.?\s?T\.?\s*(?:[:=@-]\s*)?(?:%|R\s?\d|\d|amount|amt|bedrag)/i;
const mentionsTax = (line: string) => TAX_SPELLING.test(line) || TAX_OCR_CAPS.test(line) || WAT_LABEL.test(line)
  || (line.match(/[A-Za-z]+/g) ?? []).some((w) => TAX_ROOT.test(w) && !ORDINARY.has(w.toLowerCase()));
/** A VAT-number-shaped token: a leading 4 (or OCR `A`) and 9–11 digits or OCR confusables, spacing/slashes included. */
const OCR_DIGIT = String.raw`[\dOoIlLiSsBDZzGgQq|]`;
const VAT_NUMBER = new RegExp(String.raw`(?<![A-Za-z0-9])[4A]${OCR_DIGIT}(?:[ /-]{0,2}${OCR_DIGIT}){7,9}(?![A-Za-z0-9])`);
/**
 * The head of a customer block, whatever separates its words (`Bill To`,
 * `Bill-To:`, `BILLTO`, r37): a declaration inside one is the CUSTOMER's
 * status, not the supplier's.
 */
const CUSTOMER_HEAD = /^(?:bill(?:ed)?\s*to|sold\s*to|invoice(?:d)?\s*to|deliver(?:ed|y)?\s*(?:to|address)|ship\s*to|customer|client|debtor|buyer|attn|attention|account|koper|klant|kli[eë]nt|faktuur\s*aan|lewer\s*aan|aan|to)(?![a-zë])/i;
const isCustomerHead = (line: string) => CUSTOMER_HEAD.test(line.replace(/[^A-Za-zÀ-ÿ]+/g, ' ').trim());
const TOTAL_LINE = /(?<![A-Za-z])(?:total|totaal|amount\s+due|balance\s+due|bedrag)(?![A-Za-z])/i;

/**
 * A line that opens ANY other block (r38): a label (`Billing Address:`, `Name:`,
 * `Invoice No:`, `A/C:`), a customer head, an address (`12 Main Rd`, `P.O.
 * Box 5`, `Posbus`, a postal code), or a short heading naming another party or
 * its details (`Billing Details`). The supplier's own region ends at the first.
 */
const ADDRESS_LINE = /(?<![A-Za-z])(?:p\.?\s*o\.?\s*box|private\s+bag|posbus|street|str\.|road|rd|avenue|ave|drive|lane|suite|unit|building|floor|straat|weg|laan)(?![A-Za-z])|^\s*\d+[a-z]?\s+[A-Za-z]|(?<![\d.,])\d{4}\s*$/i;
/** A short heading with no figure that names another party or its details (`Billing Details`, `Company`), colon or not. */
const BLOCK_WORD = /(?<![A-Za-z])(?:address|adres\w*|details|billing|name|naam|company|maatskappy|customer|client|recipient|purchaser|consignee|payer|buyer|debtor|debiteur|account|rekening|attn|attention|deliver\w*|ship\w*|sold|issued|supplied|prepared)(?![A-Za-z])/i;
const isHeadingLine = (line: string) => !/\d/.test(line) && line.trim().split(/\s+/).length <= 4 && BLOCK_WORD.test(line);
const isBlockLine = (line: string) => line.includes(':') || isCustomerHead(line) || ADDRESS_LINE.test(line) || isHeadingLine(line);

/**
 * Is the declaration on line `i` the SUPPLIER's? Only in the supplier's own
 * region (r38, inverted: round 37 listed customer heads, and 26 common ones —
 * `Billing Address:`, `Name:`, `Company:` — were missing): above the FIRST line
 * that opens any other block, or below the last total with no block line
 * between. Anywhere else is refused, whatever heads it.
 */
function isSuppliersLine(lines: readonly string[], i: number): boolean {
  const firstBlock = lines.findIndex(isBlockLine);
  if (firstBlock < 0 || i < firstBlock) return true;
  const lastTotal = lines.reduce((last, line, j) => (TOTAL_LINE.test(line) ? j : last), -1);
  return lastTotal >= 0 && i > lastTotal && !lines.slice(lastTotal + 1, i).some(isBlockLine);
}

/**
 * The structural tripwire (r37), independent of any word: a printed figure
 * equal, to the cent, to the tax inside the total (total × 15/115) or to 15% of
 * the total or the net is almost certainly a VAT the reader missed. With one
 * printed, "no VAT read" never counts as none, whatever it is labelled.
 */
function printsAVatFigure(text: string, total: number | null | undefined, net: number | null | undefined): boolean {
  const cents = (n: number) => Math.round(n * 100);
  const vatShapes = [total != null ? (total * 15) / 115 : null, total != null ? total * 0.15 : null, net != null ? net * 0.15 : null]
    .filter((v): v is number => v !== null && v > 0).map(cents);
  return printedFigures(text).some((f) => f.value > 0 && vatShapes.some((v) => Math.abs(cents(f.value) - v) <= 1));
}

type Extracted = Partial<Pick<ExtractedDocument, 'vatAmount' | 'rawText' | 'totalAmount' | 'subtotal'>> | null;

/** The VAT the captured document evidences, or null when it evidences none (no VAT read, and the supplier does not declare itself unregistered on an otherwise tax-free page). */
export function evidencedVat(extracted: Extracted): number | null {
  if (typeof extracted?.vatAmount === 'number') return extracted.vatAmount;
  const text = typeof extracted?.rawText === 'string' ? extracted.rawText : '';
  const lines = text.split(/\r?\n/);
  const declares = lines.some((line, i) => DECLARATION.test(line) && isSuppliersLine(lines, i));
  const elseQuiet = lines.every((line) => DECLARATION.test(line) || !mentionsTax(line)) && !VAT_NUMBER.test(text)
    && !printsAVatFigure(text, extracted?.totalAmount, extracted?.subtotal);
  return declares && elseQuiet ? 0 : null;
}

const cents = (n: number) => Math.round(n * 100);
const unevidenced = (claimed: number, evidenced: number | null) => evidenced === null || Math.abs(cents(claimed) - cents(evidenced)) > 1;

export const CAPTURED_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none only where the supplier declares itself not VAT registered), so the document does not evidence it — a person must approve it';

export const MEALS_VAT_HELD_REASON = 'it claims a meals merchant\'s input VAT on an account that does not deny it '
  + '(s17(2)(a) denies entertainment input tax unless the business trades in it), so it is held for a person';

/**
 * Why may an agent not approve each of these supplier invoices? Its tax is not
 * the VAT its captured document evidences, or it claims a meals merchant's VAT
 * (`mealsVatNeedsAPerson`, by the captured vendor or the supplier). Absent =
 * no refusal. Only invoices raised from a captured document are judged.
 */
export async function invoiceVatRefusals(companyId: string, invoiceIds: readonly string[]): Promise<Map<string, string>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT si.id, si.tax_amount, cd.extracted_data, cd.vendor_name, s.name AS supplier_name
    FROM supplier_invoices si
    JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
    LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID
      AND si.id = ANY(${[...invoiceIds]}::UUID[])
  `) as DbRow[];
  const refusals = new Map<string, string>();
  for (const row of rows) {
    const tax = Number(row.tax_amount ?? 0);
    const extracted = row.extracted_data as Extracted & { vendorName?: string | null };
    if (unevidenced(tax, evidencedVat(extracted))) refusals.set(String(row.id), CAPTURED_VAT_UNEVIDENCED_REASON);
    else if (mealsVatNeedsAPerson({ confirmed: row.vendor_name as string | null, extracted: extracted?.vendorName }, tax)
      || mealsVatNeedsAPerson({ confirmed: row.supplier_name as string | null }, tax)) {
      refusals.set(String(row.id), MEALS_VAT_HELD_REASON);
    }
  }
  return refusals;
}

export const JOURNAL_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none only where the supplier declares itself not VAT registered), so the document does not evidence it — a person must post it';

/**
 * Why may an agent not post this journal, raised from a captured document?
 * Its VAT is not what the document evidences, or it claims a meals merchant's
 * VAT (r36: the receipt routes HOLD such a draft; this is what enforces the
 * hold). Null = no refusal. Its VAT is the net debit on EVERY tax account (round 33):
 * a `vat_input` or `vat_output` line, any subtype naming VAT or tax (the
 * generic `tax` the return once read into box 15), and any account NAMED VAT
 * or BTW whatever its subtype (a NULL-subtype "VAT Payable").
 *
 * A read VAT folded into the expense is consistent with the document only
 * where s17(2)(a) folds it: every other debit is on an account that denies
 * input VAT. Denial is a property of the ACCOUNT — round 33 also excused a
 * meals merchant by vendor name, and `spur`/`mr d` matched `Spurway Steel` and
 * `Mr Doors` (round 34).
 */
export async function journalVatRefusal(companyId: string, journalId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT cd.extracted_data, cd.vendor_name,
      COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE tax.is_tax), 0) AS vat,
      COALESCE(BOOL_AND(ga.vat_input_denied) FILTER (WHERE NOT tax.is_tax AND jl.debit > 0), false) AS denied
    FROM gl_journal_entries je
    JOIN captured_documents cd ON cd.id = je.source_document_id AND cd.company_id = je.company_id
    LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
    LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
    CROSS JOIN LATERAL (SELECT (COALESCE(ga.account_subtype, '') ~* '(vat|tax)'
      OR COALESCE(ga.account_name, '') ~* '(^|[^a-z])(vat|btw|value[ -]added)([^a-z]|$)') AS is_tax) tax
    WHERE je.company_id = ${companyId}::UUID AND je.id = ${journalId}::UUID
    GROUP BY cd.id
  `) as DbRow[];
  const row = rows[0];
  if (!row) return null;
  const extracted = row.extracted_data as Extracted & { vendorName?: string | null };
  const claimed = Number(row.vat);
  const evidenced = evidencedVat(extracted);
  const deniedFold = evidenced !== null && evidenced > 0 && cents(claimed) === 0 && row.denied === true;
  if (unevidenced(claimed, evidenced) && !deniedFold) return JOURNAL_VAT_UNEVIDENCED_REASON;
  return mealsVatNeedsAPerson({ confirmed: row.vendor_name as string | null, extracted: extracted?.vendorName }, claimed)
    ? MEALS_VAT_HELD_REASON : null;
}
