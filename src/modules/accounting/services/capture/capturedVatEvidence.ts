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

const VAT = String.raw`(?:V\.?\s?A\.?\s?T\.?|B\.?\s?T\.?\s?W\.?)`;
/** The supplier's own registration status, as a whole line: a statement about an item or a customer is not one. */
const DECLARATION = new RegExp(String.raw`^\s*(?:(?:we|this\s+(?:supplier|vendor|business|company)|the\s+supplier|supplier|vendor|ons)\s+(?:is|are)\s+)?`
  + String.raw`(?:not\s+(?:a\s+)?${VAT}[\s-]*registered(?:\s+(?:vendor|supplier|business|company))?|not\s+registered\s+for\s+${VAT}`
  + String.raw`|non[\s-]*${VAT}(?:[\s-]*registered)?[\s-]+(?:vendor|supplier|business|company)`
  + String.raw`|nie\s+(?:vir\s+)?${VAT}[\s-]*geregistreer\s+nie|nie\s+geregistreer\s+vir\s+${VAT}\s+nie)\s*[.!]?\s*$`, 'i');
/**
 * Any other mention of tax, fail closed (r35–r36): a tax word glued to what
 * precedes it (`TotalVAT`, `SubtotalBTW`, `TotalTax`) but not running on into a
 * word (`private`), OCR damage (`VAl`, `V4T`, `8TW`, `V/AT`, `T.A.X.`), `incl…`,
 * or the 15% rate with decimals (`Std rate 15.00%`).
 */
const TAX_MENTION = new RegExp(String.raw`(?:${VAT}|[B8]\.?\s?T\.?\s?W\.?|V\s?\/\s?A\s?T|V\.?\s?[A4]\.?\s?[T7lI1]\.?|T\.A\.X\.?|tax|belasting)(?![A-Za-z])`
  + String.raw`|(?<![A-Za-z])incl|(?<![\d.,])15(?:[.,]\d+)?\s*(?:%|persent)`, 'i');
/** A VAT-number-shaped token: a leading 4 (or OCR `A`) and 9–11 digits or OCR confusables, spacing/slashes included. */
const OCR_DIGIT = String.raw`[\dOoIlLiSsBDZzGgQq|]`;
const VAT_NUMBER = new RegExp(String.raw`(?<![A-Za-z0-9])[4A]${OCR_DIGIT}(?:[ /-]{0,2}${OCR_DIGIT}){7,9}(?![A-Za-z0-9])`);
/** The head of a customer block: a declaration inside one is the CUSTOMER's status, not the supplier's (r36). */
const CUSTOMER_BLOCK = /^\s*(?:bill(?:ed)?\s*to|sold\s*to|invoice(?:d)?\s*to|deliver(?:ed|y)?\s*(?:to|address)|ship\s*to|customer|client|koper|klant|faktuur\s*aan|lewer\s*aan|aan)(?![A-Za-z])/i;
const TOTAL_LINE = /(?<![A-Za-z])(?:total|totaal|amount\s+due|balance\s+due|bedrag)(?![A-Za-z])/i;

/**
 * Is the declaration on line `i` the SUPPLIER's? Outside any customer block:
 * above the first one (the supplier's header) or below the last total (the
 * footer). Anywhere between is the customer's block or the body — ambiguous, so
 * refused.
 */
function isSuppliersLine(lines: readonly string[], i: number): boolean {
  const firstCustomer = lines.findIndex((line) => CUSTOMER_BLOCK.test(line));
  if (firstCustomer < 0 || i < firstCustomer) return true;
  const lastTotal = lines.reduce((last, line, j) => (TOTAL_LINE.test(line) ? j : last), -1);
  return lastTotal > firstCustomer && i > lastTotal;
}

type Extracted = Partial<Pick<ExtractedDocument, 'vatAmount' | 'rawText'>> | null;

/** The VAT the captured document evidences, or null when it evidences none (no VAT read, and the supplier does not declare itself unregistered on an otherwise tax-free page). */
export function evidencedVat(extracted: Extracted): number | null {
  if (typeof extracted?.vatAmount === 'number') return extracted.vatAmount;
  const text = typeof extracted?.rawText === 'string' ? extracted.rawText : '';
  const lines = text.split(/\r?\n/);
  const declares = lines.some((line, i) => DECLARATION.test(line) && isSuppliersLine(lines, i));
  const elseQuiet = lines.every((line) => DECLARATION.test(line) || !TAX_MENTION.test(line)) && !VAT_NUMBER.test(text);
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
    else if ([extracted?.vendorName, row.vendor_name, row.supplier_name].some((v) => mealsVatNeedsAPerson(v as string | null, tax))) {
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
  const vendors = [extracted?.vendorName, row.vendor_name as string | null];
  return vendors.some((v) => mealsVatNeedsAPerson(v, claimed)) ? MEALS_VAT_HELD_REASON : null;
}
