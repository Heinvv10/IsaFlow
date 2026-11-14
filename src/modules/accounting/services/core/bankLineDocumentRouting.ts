/**
 * A bank line as a document ENTITY: the routing that lets /api/accounting/documents and the MCP document tools take
 * `entity_type: 'bank_transaction'` like any other, so a caller never has to know that a bank line's files live in
 * their own store (bank_transaction_attachments + captured documents linked to the line) rather than in
 * procurement_documents. The old /bank-tx-attachments endpoint and attach_document keep working on the same rows.
 *
 * Reads go through capture/capturedAttachmentLinks (what the bank grid shows), writes through
 * bank/bankTxAttachmentService.addBankTxAttachment; both are company-fenced through the line, and ownership is checked
 * HERE first so a foreign line and a missing one are indistinguishable. This module never writes SQL against the
 * attachments table itself apart from the duplicate probe, which joins the line's own company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { LinkedDocument } from '@/types/procurement/document.types';
import { VALID_ENTITY_TYPES } from './documentStorageService';
import { listBankLineAttachments, type BankLineAttachment } from '../capture/capturedAttachmentLinks';
import { uploadFileName } from '../bank/bankLineDocumentSql';
import type { BankTxAttachmentRow } from '../bank/bankTxAttachmentService';

export const BANK_ENTITY_TYPE = 'bank_transaction';
/** Every entity type the document endpoints and tools accept. */
export const DOCUMENT_ENTITY_TYPES = [...VALID_ENTITY_TYPES, BANK_ENTITY_TYPE] as const;

export const isBankEntityType = (entityType: unknown): entityType is typeof BANK_ENTITY_TYPE =>
  entityType === BANK_ENTITY_TYPE;

export async function bankTxBelongsToCompany(companyId: string, bankTxId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows.length > 0;
}

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function dataUrlMime(url: string): string | undefined {
  return /^data:([^;,]+)[;,]/.exec(url)?.[1];
}

function fromAttachment(a: BankLineAttachment, bankTxId: string): LinkedDocument {
  return {
    id: a.id,
    entityType: BANK_ENTITY_TYPE,
    entityId: bankTxId,
    documentType: 'other',
    documentName: a.file_name,
    fileUrl: a.file_url,
    ...(a.file_size == null ? {} : { fileSize: a.file_size }),
    ...((a.content_type ?? dataUrlMime(a.file_url)) ? { mimeType: (a.content_type ?? dataUrlMime(a.file_url))! } : {}),
    uploadedBy: a.uploaded_by ?? '',
    uploadedAt: iso(a.created_at),
    isActive: true,
    source: 'direct',
  };
}

/** A just-stored bank-line file, in the entity-document shape. */
export function fromStoredAttachment(a: BankTxAttachmentRow): LinkedDocument {
  return {
    id: a.id,
    entityType: BANK_ENTITY_TYPE,
    entityId: a.bankTransactionId,
    documentType: 'other',
    documentName: a.fileName,
    fileUrl: '',
    fileSize: a.fileSize,
    mimeType: a.mimeType,
    uploadedBy: '',
    uploadedAt: a.createdAt,
    isActive: true,
    source: 'direct',
  };
}

export type BankLineDocumentsResult =
  | { ok: true; documents: LinkedDocument[]; hasMore: boolean }
  | { ok: false; reason: 'entity_not_found' };

/** The line's supporting documents (uploads, and each linked captured document once), newest first. */
export async function listBankLineDocuments(
  companyId: string, bankTxId: string, limit: number, offset: number,
): Promise<BankLineDocumentsResult> {
  // BEFORE any read.
  if (!(await bankTxBelongsToCompany(companyId, bankTxId))) return { ok: false, reason: 'entity_not_found' };
  const all = await listBankLineAttachments(companyId, bankTxId);
  return {
    ok: true,
    hasMore: all.length > offset + limit,
    documents: all.slice(offset, offset + limit).map((a) => fromAttachment(a, bankTxId)),
  };
}

/**
 * A file already on this line under the same stored name and size, so a bulk back-fill can be re-run without storing
 * every file twice (the entity store does the same, documentStorageService.findActiveDuplicate). The caller has
 * verified the line is the company's.
 */
export async function findBankLineDuplicate(
  companyId: string, bankTxId: string, fileName: string, size: number,
): Promise<LinkedDocument | null> {
  const [row] = (await sql`
    SELECT a.id, a.bank_transaction_id, a.file_name, a.file_size, a.created_at, a.file_url
      FROM bank_transaction_attachments a
      JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
     WHERE a.bank_transaction_id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
       AND a.file_name = ${uploadFileName(fileName)} AND a.file_size = ${size}
     ORDER BY a.created_at, a.id
     LIMIT 1
  `) as DbRow[];
  if (!row) return null;
  return fromStoredAttachment({
    id: String(row.id),
    bankTransactionId: String(row.bank_transaction_id),
    fileName: String(row.file_name),
    fileSize: Number(row.file_size),
    mimeType: dataUrlMime(String(row.file_url ?? '')) ?? 'application/octet-stream',
    createdAt: iso(row.created_at as string | Date),
  });
}
