/**
 * Attach a document (receipt, invoice scan) to a bank transaction — the
 * service form of what POST /api/accounting/bank-tx-attachments does inline.
 *
 * Storage is the route's convention: the file travels as a `data:` URL in
 * `bank_transaction_attachments.file_url` (≤ 2 MB there; callers may cap
 * lower). The table has NO company_id, so tenant isolation rides entirely on
 * the bank-transaction ownership check that runs BEFORE the insert — keep that
 * ordering.
 *
 * The declared MIME is caller-controlled; the decoded bytes are what decide
 * (magic-byte sniff, pentest H6). A mismatch is a refusal, never a coercion.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import { magicBytesMatchMime } from '@/lib/fileMagic';

export const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

export interface AddAttachmentInput {
  bankTransactionId: string;
  fileName: string;
  mimeType: AttachmentMime;
  /** Decoded file bytes — never a data URL. */
  bytes: Buffer;
  /** Hard cap on `bytes.length`; the route's own is 2 MB. */
  maxBytes: number;
  /** Stored in uploaded_by when it is a UUID; PAT/legacy ids are dropped rather than cast. */
  uploadedBy: string | null;
}

export type AddAttachmentResult =
  | { ok: true; attachment: BankTxAttachmentRow }
  | { ok: false; reason: 'bank_tx_not_found' | 'type_mismatch' | 'too_large' | 'empty' };

export interface BankTxAttachmentRow {
  id: string;
  bankTransactionId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
}

function mapRow(r: DbRow, mimeType: string): BankTxAttachmentRow {
  return {
    id: String(r.id),
    bankTransactionId: String(r.bank_transaction_id),
    fileName: String(r.file_name ?? ''),
    fileSize: Number(r.file_size ?? 0),
    mimeType,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

export async function addBankTxAttachment(
  companyId: string,
  input: AddAttachmentInput,
): Promise<AddAttachmentResult> {
  const { bytes } = input;
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > input.maxBytes) return { ok: false, reason: 'too_large' };
  if (!magicBytesMatchMime(bytes, input.mimeType)) return { ok: false, reason: 'type_mismatch' };

  // Ownership BEFORE the write — the attachments table cannot fence itself.
  const [tx] = (await sql`
    SELECT id FROM bank_transactions
    WHERE id = ${input.bankTransactionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!tx) return { ok: false, reason: 'bank_tx_not_found' };

  const dataUrl = `data:${input.mimeType};base64,${bytes.toString('base64')}`;
  const uploadedBy = input.uploadedBy && UUID_RE.test(input.uploadedBy) ? input.uploadedBy : null;

  const [row] = (await sql`
    INSERT INTO bank_transaction_attachments
      (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
    VALUES
      (${input.bankTransactionId}::UUID, ${dataUrl}, ${input.fileName}, ${bytes.length}, ${uploadedBy}::UUID)
    RETURNING id, bank_transaction_id, file_name, file_size, created_at
  `) as DbRow[];

  log.info('Attached document to bank transaction', {
    companyId, bankTransactionId: input.bankTransactionId, fileName: input.fileName, bytes: bytes.length,
  }, 'bank-tx-attachments');

  return { ok: true, attachment: mapRow(row!, input.mimeType) };
}

export interface BankTxAttachmentDetail extends BankTxAttachmentRow {
  /** Base64 file bytes, present only when the caller asked for them. */
  content?: string;
}

/**
 * One attachment, by id. The read side of addBankTxAttachment.
 *
 * The tenant fence is the JOIN to bank_transactions — this table has no
 * company_id — so a document belonging to another company returns null and is
 * indistinguishable from a genuine miss.
 *
 * `file_url` holds a `data:<mime>;base64,…` URL (see the module note), so the
 * mime type and the bytes are both parsed out of it rather than stored
 * separately.
 */
export async function getBankTxAttachment(
  companyId: string,
  attachmentId: string,
  includeContent = false,
): Promise<BankTxAttachmentDetail | null> {
  const [row] = (await sql`
    SELECT a.id, a.bank_transaction_id, a.file_name, a.file_size, a.created_at, a.file_url
    FROM bank_transaction_attachments a
    JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
    WHERE a.id = ${attachmentId}::UUID AND bt.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!row) return null;

  const url = String(row.file_url ?? '');
  const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
  const mimeType = match ? match[1]! : 'application/octet-stream';
  const base = mapRow(row, mimeType);
  return includeContent && match ? { ...base, content: match[2]! } : base;
}
