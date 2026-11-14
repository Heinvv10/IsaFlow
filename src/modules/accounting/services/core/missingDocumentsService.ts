/**
 * Which accounting documents lack a supporting document — the read side behind the MCP tool list_missing_documents.
 *
 * "Has a document" is COMPUTED on every call from the document tables, never from a cached flag:
 *  - supplier bills, customer invoices, credit notes: core/documentPresenceSql (the SAME fragment the bill/invoice
 *    `hasDocument` flag and the "Missing document" filter use);
 *  - bank spend lines: bank/bankLineDocumentSql (the grid's paperclip);
 *  - journals with input-VAT lines: reports/vatInputSupport (`findInputVatSupport`), the pre-filing check, so this list
 *    and the VAT exception screen cannot disagree. A journal is missing a document when that check answers
 *    no_document, no_tax_invoice (a bank-backed or VAT-adjustment claim with no tax invoice on the line) or
 *    document_unlinked. Those answers are about the VAT claim, so a journal built from an undocumented bank line is
 *    listed under BOTH bank_transaction and vat_journal: the per-type summaries overlap by design.
 *
 * Paging is one keyset over all types: cents DESC, entity type, id. Each source returns its first `limit + 1` rows after
 * the cursor in that order and the merge keeps the first `limit + 1` of the union, which is exactly the global page.
 */
import { findInputVatSupport } from '../reports/vatInputSupport';
import { pageSqlTypes, summariseSqlTypes } from './missingDocumentsQuery';
import {
  compareMissingKeys,
  type MissingDocumentFilters, type MissingDocumentKey, type MissingDocumentPage, type MissingDocumentRow,
  type MissingDocumentSummary,
} from './missingDocumentsTypes';

const NO_DOCUMENT_REASONS: ReadonlySet<string> = new Set(['no_document', 'no_tax_invoice', 'document_unlinked']);

const keyOf = (r: MissingDocumentRow): MissingDocumentKey => ({ cents: r.cents, entityType: r.entityType, id: r.entityId });

/** Input-VAT claims with no document behind them in [from, to], as rows in the common shape. */
async function vatJournalRows(f: MissingDocumentFilters): Promise<MissingDocumentRow[]> {
  const { unsupported, withoutTaxInvoice } = await findInputVatSupport(f.companyId, f.from, f.to);
  return [...unsupported, ...withoutTaxInvoice]
    .filter((l) => NO_DOCUMENT_REASONS.has(l.reason) && Math.abs(l.claimedVat) >= f.minAmount)
    .map((l): MissingDocumentRow => ({
      entityType: 'vat_journal',
      entityId: l.journalEntryId,
      documentDate: l.entryDate,
      amount: Math.abs(l.claimedVat),
      cents: Math.round(Math.abs(l.claimedVat) * 100),
      reference: l.entryNumber,
      counterparty: null,
      description: l.description || null,
      status: l.source,
      reason: l.reason,
    }));
}

export async function listMissingDocuments(f: MissingDocumentFilters): Promise<MissingDocumentPage> {
  const wantsVat = f.types.includes('vat_journal');
  const [sqlSummary, sqlRows, vatRows] = await Promise.all([
    summariseSqlTypes(f),
    pageSqlTypes(f, f.limit + 1),
    wantsVat ? vatJournalRows(f) : Promise.resolve([] as MissingDocumentRow[]),
  ]);

  const summary: MissingDocumentSummary[] = f.types
    .filter((t) => t !== 'vat_journal')
    .map((t) => sqlSummary.find((s) => s.entityType === t)
      ?? { entityType: t, candidates: 0, withDocument: 0, missing: 0, missingAmount: 0 });
  if (wantsVat) {
    const cents = vatRows.reduce((sum, r) => sum + r.cents, 0);
    summary.push({
      entityType: 'vat_journal', candidates: null, withDocument: null,
      missing: vatRows.length, missingAmount: cents / 100,
    });
  }

  const after = f.after;
  const vatAfter = after === null ? vatRows : vatRows.filter((r) => compareMissingKeys(keyOf(r), after) > 0);
  const merged = [...sqlRows, ...vatAfter].sort((a, b) => compareMissingKeys(keyOf(a), keyOf(b)));
  const rows = merged.slice(0, f.limit);
  return { rows, next: merged.length > f.limit && rows.length > 0 ? keyOf(rows[rows.length - 1]!) : null, summary };
}
