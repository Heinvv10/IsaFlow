/**
 * What counts as a bank line's supporting documents, as SQL fragments: ONE definition for the grid's paperclip, the
 * client-queries list, the attachments modal, the MCP document tools and the VAT input support report, so no two
 * screens disagree about whether a line is supported.
 *
 * A line's documents are
 *  - its rows in bank_transaction_attachments (uploads, WhatsApp replies, attach_document, and copies of captured
 *    documents), and
 *  - captured documents linked to it (captured_documents.matched_bank_tx_id) that have stored bytes, are not
 *    rejected, and have NO copy on the line. Linking copies a document only up to 2 MB, so a larger one exists only
 *    here; a copied one is counted once, as its copy.
 * A copy is recognised by its file_name, "<captured document id>_<name>" (captureBankTxAttachService builds it from
 * the document's own id, lower-case).
 *
 * Aliases are fixed code constants, never input, so these are safe for sql.unsafe. Tenant scope: copies are reached
 * only through the line's id; a captured document must carry the line's own company_id, so a link forged across
 * companies is never counted. This module imports nothing: bank fragments must not pull in capture's storage code.
 */

type Alias = 'bt' | 'cd' | 'm' | 'bta' | 'x';

/** captured document `cd` is a supporting document of bank line `bt` (before the copy check). */
export function linkedCapturedDocSql(bt: Alias = 'bt', cd: Alias = 'cd'): string {
  return `${cd}.matched_bank_tx_id = ${bt}.id AND ${cd}.company_id = ${bt}.company_id`
    + ` AND ${cd}.storage_path IS NOT NULL AND ${cd}.status <> 'rejected'`;
}

/** attachment row `m` is the copy of captured document `cd`. */
export function isCopyOfSql(m: Alias, cd: Alias = 'cd'): string {
  return `lower(left(${m}.file_name, 37)) = ${cd}.id::text || '_'`;
}

/** captured document `cd`, linked to bank line `bt`, has no copy on that line. */
export function hasNoCopySql(bt: Alias = 'bt', cd: Alias = 'cd'): string {
  return `NOT EXISTS (SELECT 1 FROM bank_transaction_attachments m WHERE m.bank_transaction_id = ${bt}.id AND ${isCopyOfSql('m', cd)})`;
}

/** The number of supporting documents of bank line `bt`, for a SELECT list. */
export function attachmentCountSql(bt: Alias = 'bt'): string {
  return `(
    (SELECT COUNT(*)::INT FROM bank_transaction_attachments x WHERE x.bank_transaction_id = ${bt}.id)
    + (SELECT COUNT(*)::INT FROM captured_documents cd WHERE ${linkedCapturedDocSql(bt, 'cd')} AND ${hasNoCopySql(bt, 'cd')})
  )`;
}

/** Bank line `bt` has at least one supporting document, as a boolean expression. */
export function hasBankLineDocumentSql(bt: Alias = 'bt'): string {
  return `(EXISTS (SELECT 1 FROM bank_transaction_attachments x WHERE x.bank_transaction_id = ${bt}.id)`
    + ` OR EXISTS (SELECT 1 FROM captured_documents cd WHERE ${linkedCapturedDocSql(bt, 'cd')}))`;
}

const COPY_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i;

/**
 * A file name any writer OTHER than the captured-document copy may store. A name shaped like a copy's
 * ("<uuid>_…") would make an upload pass for a linked document's copy and hide that document, so it gains an
 * "upload_" prefix. Every writer of bank_transaction_attachments but captureBankTxAttachService calls this.
 */
export function uploadFileName(name: string): string {
  return COPY_PREFIX.test(name) ? `upload_${name}` : name;
}
