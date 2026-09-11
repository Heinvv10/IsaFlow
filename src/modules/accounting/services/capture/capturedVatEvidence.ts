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
 * or — when none was read — 0, but only if the document's text prints no tax at
 * all (round 33). The text reader misses `VAT INCL 375.00` and reads `Incl. VAT
 * 375.00` as a total, so "none read" on a document that mentions VAT, BTW, tax
 * or 15% anywhere is not evidence of none; it is refused, as round 31 did. A
 * document with no text proves nothing and is refused too. A person approving
 * in the attended workflow is not affected.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { TAX_WORD } from '@/modules/accounting/services/core/ocrAmountPatterns';
import { parseReceiptType } from '@/modules/accounting/services/bank/receiptToJournalService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

/** Any tax on the page: the reader's tax word (`VAT`, `V.A.T.`, `BTW`, `Tax…`, `Belasting…`) or the 15% rate. Fails closed. */
const PRINTS_TAX = new RegExp(String.raw`(?<![A-Za-z])${TAX_WORD}|(?<![\d.,])15(?:[.,]0+)?\s*%`, 'i');

type Extracted = Partial<Pick<ExtractedDocument, 'vatAmount' | 'rawText' | 'vendorName'>> | null;

/** The VAT the captured document evidences, or null when it evidences none (a VAT was not read, and the page may show one). */
export function evidencedVat(extracted: Extracted): number | null {
  if (typeof extracted?.vatAmount === 'number') return extracted.vatAmount;
  const text = typeof extracted?.rawText === 'string' ? extracted.rawText : '';
  return text.trim().length > 0 && !PRINTS_TAX.test(text) ? 0 : null;
}

const cents = (n: number) => Math.round(n * 100);
const unevidenced = (claimed: number, evidenced: number | null) => evidenced === null || Math.abs(cents(claimed) - cents(evidenced)) > 1;

export const CAPTURED_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none only where the document prints no tax at all), so the document does not evidence it — a person must approve it';

/** Of these supplier invoices, which carry a `tax_amount` their captured document does not evidence? */
export async function invoicesWithUnevidencedVat(companyId: string, invoiceIds: readonly string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const rows = (await sql`
    SELECT si.id, si.tax_amount, cd.extracted_data
    FROM supplier_invoices si
    JOIN captured_documents cd ON cd.id = si.source_document_id AND cd.company_id = si.company_id
    WHERE si.company_id = ${companyId}::UUID
      AND si.id = ANY(${[...invoiceIds]}::UUID[])
  `) as DbRow[];
  return new Set(rows.filter((row) => unevidenced(Number(row.tax_amount ?? 0), evidencedVat(row.extracted_data as Extracted)))
    .map((row) => String(row.id)));
}

export const JOURNAL_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none only where the document prints no tax at all), so the document does not evidence it — a person must post it';

/**
 * Does this journal, raised from a captured document, carry a VAT the document
 * does not evidence? Its VAT is the net debit on EVERY tax account (round 33):
 * a `vat_input` or `vat_output` line, any subtype naming VAT or tax (the
 * generic `tax` the return once read into box 15), and any account NAMED VAT
 * or BTW whatever its subtype (a NULL-subtype "VAT Payable").
 *
 * A read VAT folded into the expense is consistent with the document where the
 * receipt builder would fold it (s17(2)(a)): every other debit is on an account
 * that denies input VAT, or the vendor is a meals merchant.
 */
export async function journalHasUnevidencedVat(companyId: string, journalId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT cd.extracted_data,
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
  if (!row) return false;
  const extracted = row.extracted_data as Extracted;
  const claimed = Number(row.vat);
  const evidenced = evidencedVat(extracted);
  if (!unevidenced(claimed, evidenced)) return false;
  const deniedFold = evidenced !== null && evidenced > 0 && cents(claimed) === 0
    && (row.denied === true || parseReceiptType(extracted as ExtractedDocument) === 'meals');
  return !deniedFold;
}
