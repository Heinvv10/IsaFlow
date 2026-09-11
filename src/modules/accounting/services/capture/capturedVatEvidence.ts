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
 * is not a VAT document (round 34). Rounds 32–33 read "no tax word printed" as
 * that signal, and a word list fails OPEN: `B.T.W. 375.00` on a `FAKTUUR` was a
 * tax neither the reader nor the list saw, so an agent approved the bill with
 * no VAT. Now the document must SAY no VAT applies (`Not VAT registered`, `nie
 * BTW-geregistreer nie`, …) and print no VAT registration number; a phrase the
 * list lacks costs a refusal, never an approval. The supplier master is not a
 * signal: `suppliers.vat_number` NULL means "not captured", not "not registered".
 * A person approving in the attended workflow is not affected.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

/**
 * The document declares of ITSELF that no VAT applies. Whole-vendor statements
 * only: `No VAT on disbursements` is a VAT invoice's footnote, so a bare `No
 * VAT` counts only as a line of its own.
 */
const VAT = String.raw`(?:V\.?\s?A\.?\s?T\.?|B\.?\s?T\.?\s?W\.?)`;
const DECLARES_NO_VAT = new RegExp(String.raw`(?<![A-Za-z])(?:not\s+(?:a\s+)?${VAT}[\s-]*(?:registered|vendor|supplier)`
  + String.raw`|not\s+registered\s+for\s+${VAT}|non[\s-]*${VAT}[\s-]*(?:registered|vendor|supplier)|${VAT}\s+(?:is\s+)?not\s+applicable`
  + String.raw`|nie\s+(?:vir\s+)?${VAT}[\s-]*geregistreer\s+nie|nie\s+geregistreer\s+vir\s+${VAT}\s+nie)(?![A-Za-z])`
  + String.raw`|^\s*(?:no\s+${VAT}(?:\s+charged)?|geen\s+${VAT})\s*$`, 'im');
/** A SA VAT registration number (ten digits, leading 4): a VAT vendor prints one on every tax invoice. */
const VAT_NUMBER = /(?<!\d)4(?:[\s-]?\d){9}(?!\d)/;

type Extracted = Partial<Pick<ExtractedDocument, 'vatAmount' | 'rawText'>> | null;

/** The VAT the captured document evidences, or null when it evidences none (no VAT read, and nothing says none applies). */
export function evidencedVat(extracted: Extracted): number | null {
  if (typeof extracted?.vatAmount === 'number') return extracted.vatAmount;
  const text = typeof extracted?.rawText === 'string' ? extracted.rawText : '';
  return DECLARES_NO_VAT.test(text) && !VAT_NUMBER.test(text) ? 0 : null;
}

const cents = (n: number) => Math.round(n * 100);
const unevidenced = (claimed: number, evidenced: number | null) => evidenced === null || Math.abs(cents(claimed) - cents(evidenced)) > 1;

export const CAPTURED_VAT_UNEVIDENCED_REASON = 'its VAT is not the VAT read off the captured document it was raised from '
  + '(none only where the document says no VAT applies), so the document does not evidence it — a person must approve it';

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
  + '(none only where the document says no VAT applies), so the document does not evidence it — a person must post it';

/**
 * Does this journal, raised from a captured document, carry a VAT the document
 * does not evidence? Its VAT is the net debit on EVERY tax account (round 33):
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
  const deniedFold = evidenced !== null && evidenced > 0 && cents(claimed) === 0 && row.denied === true;
  return !deniedFold;
}
