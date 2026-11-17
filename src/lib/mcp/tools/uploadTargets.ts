/**
 * Shared by create_upload_urls and finalize_uploads: what a target is, what it accepts, and whether a file is already
 * on it (so neither tool stores the same document twice).
 */
import {
  ALLOWED_MIME_TYPES, VALID_DOCUMENT_TYPES, findActiveDuplicate, verifyEntityOwnershipTyped,
} from '@/modules/accounting/services/core/documentStorageService';
import { ATTACHMENT_MIME_TYPES } from '@/modules/accounting/services/bank/bankTxAttachmentService';
import { bankTxBelongsToCompany, findBankLineDuplicate } from '@/modules/accounting/services/core/bankLineDocumentRouting';
import { findBankLineShaDuplicate } from '@/modules/accounting/services/bank/bankLineShaDuplicate';
import { findFinalizedSameBytes, type UploadTargetKind } from '@/modules/accounting/services/core/mcpUploadIntentStore';
import type { AccountingEntityType } from '@/types/procurement/document.types';

/** A bank line stores the file inline as a data URL; 2 MB is the bank-tx-attachments route's own cap. */
export const BANK_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** The entity store keeps files in object storage; staged bytes sit in Postgres until finalize, so 10 MB, not 20. */
export const ENTITY_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_FILE_NAME = 200;
export const MAX_UPLOAD_ITEMS = 100;

export const ENTITY_TARGET_KINDS = [
  'supplier_invoice', 'customer_invoice', 'credit_note', 'supplier_payment', 'customer_payment',
] as const satisfies readonly AccountingEntityType[];

export const isBankKind = (k: UploadTargetKind): boolean => k === 'bank_transaction';

export function maxBytesFor(kind: UploadTargetKind): number {
  return isBankKind(kind) ? BANK_UPLOAD_MAX_BYTES : ENTITY_UPLOAD_MAX_BYTES;
}

export function mimeAllowedFor(kind: UploadTargetKind, mime: string): boolean {
  const allowed: readonly string[] = isBankKind(kind) ? ATTACHMENT_MIME_TYPES : ALLOWED_MIME_TYPES;
  return allowed.includes(mime);
}

export function mimeListFor(kind: UploadTargetKind): string {
  return (isBankKind(kind) ? ATTACHMENT_MIME_TYPES : ALLOWED_MIME_TYPES).join(', ');
}

export function defaultDocumentType(kind: UploadTargetKind): string | null {
  switch (kind) {
    case 'bank_transaction': return null;
    case 'credit_note': return 'credit_note_doc';
    case 'supplier_payment':
    case 'customer_payment': return 'proof_of_payment';
    default: return 'invoice';
  }
}

export const isValidDocumentType = (t: string): boolean => (VALID_DOCUMENT_TYPES as readonly string[]).includes(t);

/** The target is this company's row of the declared kind. Cross-tenant and a genuine miss read the same. */
export async function targetBelongsToCompany(companyId: string, kind: UploadTargetKind, id: string): Promise<boolean> {
  return isBankKind(kind)
    ? bankTxBelongsToCompany(companyId, id)
    : verifyEntityOwnershipTyped(kind as AccountingEntityType, id, companyId);
}

/**
 * The id of a document already on the target that this file duplicates: the same bytes uploaded through this flow
 * before (and still there), the same bytes on a bank line, or the same stored name and size (the rule
 * attach_entity_document uses). Null when the file is new. The caller has verified the target is the company's.
 */
export async function findExistingDocument(
  companyId: string, kind: UploadTargetKind, targetId: string, fileName: string, size: number, sha256: string,
): Promise<string | null> {
  const viaUpload = await findFinalizedSameBytes(companyId, kind, targetId, sha256);
  if (viaUpload) return viaUpload;
  if (isBankKind(kind)) {
    const sameBytes = await findBankLineShaDuplicate(companyId, targetId, sha256);
    if (sameBytes) return sameBytes;
    return (await findBankLineDuplicate(companyId, targetId, fileName, size))?.id ?? null;
  }
  return (await findActiveDuplicate(kind, targetId, fileName, size))?.id ?? null;
}
