/**
 * What counts as a bank line's supporting documents, as SQL fragments: ONE definition for the grid's paperclip, the
 * client-queries list, the attachments modal, the MCP document tools and the VAT input support report, so no two
 * screens disagree about whether a line is supported.
 *
 * A line's documents are
 *  - its rows in bank_transaction_attachments (uploads, WhatsApp replies, attach_document, and copies of captured
 *    documents still linked to this line and not rejected), and
 *  - captured documents linked to it (captured_documents.matched_bank_tx_id) that have stored bytes, are not
 *    rejected, and have NO copy on the line. Linking copies a document only up to 2 MB, so a larger one exists only
 *    here; a copied one is counted once, as its copy.
 * A copy is recognised by its file_name, "<captured document id>_<name>" (captureBankTxAttachService builds it from
 * the document's own id, lower-case).
 *
 * A proof of payment (captured_documents.document_type 'proof_of_payment', capture/pop/) is a bank's payment notice,
 * not a tax invoice: it is one of the line's documents for the paperclip and the attachments list
 * (attachmentCountSql, attachmentCountsSql, linkedCapturedDocSql), but it does NOT support the line
 * (hasBankLineDocumentSql: the unsupported-transactions list and the VAT input support report). Neither the POP
 * linked to the line nor its copy counts there.
 *
 * Aliases are fixed code constants, never input, so these are safe for sql.unsafe. Tenant scope: copies are reached
 * only through the line's id; a captured document must carry the line's own company_id, so a link forged across
 * companies is never counted. This module imports nothing: bank fragments must not pull in capture's storage code.
 */

type Alias = 'bt' | 'cd' | 'm' | 'bta' | 'x' | 'a' | 'cx' | 'cp';

/** captured document `cd` is a supporting document of bank line `bt` (before the copy check). */
export function linkedCapturedDocSql(bt: Alias = 'bt', cd: Alias = 'cd'): string {
  return `${cd}.matched_bank_tx_id = ${bt}.id AND ${cd}.company_id = ${bt}.company_id`
    + ` AND NULLIF(${cd}.storage_path, '') IS NOT NULL AND ${cd}.status <> 'rejected'`;
}

/** attachment row `m` is the copy of captured document `cd`. */
export function isCopyOfSql(m: Alias, cd: Alias = 'cd'): string {
  return `lower(left(${m}.file_name, 37)) = ${cd}.id::text || '_'`;
}

/** The captured document id a copy's file name carries, as a uuid, or NULL for any other name (a primary-key probe). */
function copiedDocIdSql(x: Alias): string {
  return `(CASE WHEN ${x}.file_name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_'`
    + ` THEN lower(left(${x}.file_name, 36))::uuid END)`;
}

/**
 * Attachment row `x` on bank line `bt` is one of the line's documents: an upload, or the copy of a captured document
 * that is still linked to THIS line and not rejected. A copy left behind by a relink (from before attach removed it)
 * or the copy of a rejected document supports nothing, the same as that document would without a copy.
 */
export function attachmentCountsSql(x: Alias, bt: Alias = 'bt'): string {
  return `NOT EXISTS (SELECT 1 FROM captured_documents cx WHERE cx.id = ${copiedDocIdSql(x)}`
    + ` AND cx.company_id = ${bt}.company_id AND (cx.status = 'rejected' OR cx.matched_bank_tx_id IS DISTINCT FROM ${bt}.id))`;
}

/** captured document `cd`, linked to bank line `bt`, has no copy on that line. */
export function hasNoCopySql(bt: Alias = 'bt', cd: Alias = 'cd'): string {
  return `NOT EXISTS (SELECT 1 FROM bank_transaction_attachments m WHERE m.bank_transaction_id = ${bt}.id AND ${isCopyOfSql('m', cd)})`;
}

/** The number of supporting documents of bank line `bt`, for a SELECT list. */
export function attachmentCountSql(bt: Alias = 'bt'): string {
  return `(
    (SELECT COUNT(*)::INT FROM bank_transaction_attachments x WHERE x.bank_transaction_id = ${bt}.id AND ${attachmentCountsSql('x', bt)})
    + (SELECT COUNT(*)::INT FROM captured_documents cd WHERE ${linkedCapturedDocSql(bt, 'cd')} AND ${hasNoCopySql(bt, 'cd')})
  )`;
}

/**
 * Bank line `bt` has at least one supporting document, as a boolean expression. A proof of payment, linked or
 * copied, is not one (see the header).
 */
export function hasBankLineDocumentSql(bt: Alias = 'bt'): string {
  return `(EXISTS (SELECT 1 FROM bank_transaction_attachments x WHERE x.bank_transaction_id = ${bt}.id AND ${attachmentCountsSql('x', bt)}`
    + ` AND NOT EXISTS (SELECT 1 FROM captured_documents cp WHERE cp.id = ${copiedDocIdSql('x')}`
    + ` AND cp.company_id = ${bt}.company_id AND cp.document_type = 'proof_of_payment'))`
    + ` OR EXISTS (SELECT 1 FROM captured_documents cd WHERE ${linkedCapturedDocSql(bt, 'cd')}`
    + ` AND cd.document_type IS DISTINCT FROM 'proof_of_payment'))`;
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
