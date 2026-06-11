/**
 * Bank-Tx Client Query — inbound reply side (Dotbiz Workstream D).
 * Called from whatsAppInboundService when a WhatsApp message arrives from a
 * number with an open query: media attaches to the queried bank transaction
 * (bank_transaction_attachments, same surface as manual uploads) and the
 * query flips to 'replied'.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';
import { normalizeWhatsAppNumber } from './bankTxQueryMessage';

type Row = DbRow;

/** Same cap as the manual upload API (bank-tx-attachments.ts). */
const MAX_ATTACH_BYTES = 2 * 1024 * 1024;

/** Allowed reply media MIME types — defense-in-depth re-validation. */
const MIME_RE = /^(image\/(jpeg|jpg|png|webp|tiff)|application\/pdf)$/;

export interface OpenQuery {
  id: string;
  bankTransactionId: string;
  status: 'sent' | 'replied';
}

export async function findOpenQuery(
  companyId: string,
  fromNumber: string,
): Promise<OpenQuery | null> {
  const normalized = normalizeWhatsAppNumber(fromNumber);
  if (!normalized) return null;
  const [row] = (await sql`
    SELECT id, bank_transaction_id, status
    FROM bank_tx_queries
    WHERE company_id = ${companyId}::uuid
      AND to_number = ${normalized}
      AND status IN ('sent', 'replied')
    ORDER BY (status = 'sent') DESC, sent_at DESC
    LIMIT 1
  `) as Row[];
  if (!row) return null;
  return {
    id: String(row.id),
    bankTransactionId: String(row.bank_transaction_id),
    status: row.status as 'sent' | 'replied',
  };
}

export interface ReplyMedia {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * Attach reply media to the queried bank transaction.
 * Tenant safety (defense-in-depth): although `query` comes from findOpenQuery
 * (which is company-scoped), we re-verify that the bank_transaction belongs to
 * the company before inserting — matching the guard in the manual-upload API
 * (bank-tx-attachments.ts).
 */
export async function attachReplyMedia(
  companyId: string,
  query: OpenQuery,
  media: ReplyMedia,
): Promise<boolean> {
  if (media.buffer.length > MAX_ATTACH_BYTES) {
    log.warn('bankTxQueryReply: media over attachment cap — captured but not attached', {
      companyId, queryId: query.id, size: media.buffer.length, fileName: media.fileName,
    }, 'bank-tx-queries');
    return false;
  }

  // Re-validate mimeType before building the data URL.
  if (!MIME_RE.test(media.mimeType)) {
    log.warn('bankTxQueryReply: refusing attach for unexpected mime type', {
      companyId, queryId: query.id, mimeType: media.mimeType,
    }, 'bank-tx-queries');
    return false;
  }

  // Ownership preflight: verify the bank tx belongs to this company (defense-in-depth).
  const [owner] = (await sql`
    SELECT id FROM bank_transactions
    WHERE id = ${query.bankTransactionId}::uuid AND company_id = ${companyId}::uuid
    LIMIT 1
  `) as Row[];
  if (!owner) {
    log.error('bankTxQueryReply: bank tx does not belong to company — refusing attach', {
      companyId, queryId: query.id, bankTransactionId: query.bankTransactionId,
    }, 'bank-tx-queries');
    return false;
  }

  // Retry-dedupe: fileName embeds the Twilio MessageSid, so a webhook retry
  // would re-attach the identical file. Skip silently and return true so the
  // caller still marks the query replied.
  const [dup] = (await sql`
    SELECT id FROM bank_transaction_attachments
    WHERE bank_transaction_id = ${query.bankTransactionId}::uuid AND file_name = ${media.fileName}
    LIMIT 1
  `) as Row[];
  if (dup) {
    log.info('bankTxQueryReply: attachment already exists (webhook retry) — skipping duplicate', {
      companyId, queryId: query.id, fileName: media.fileName,
    }, 'bank-tx-queries');
    return true;
  }

  const dataUrl = `data:${media.mimeType};base64,${media.buffer.toString('base64')}`;
  await sql`
    INSERT INTO bank_transaction_attachments
      (bank_transaction_id, file_url, file_name, file_size, uploaded_by)
    VALUES
      (${query.bankTransactionId}::uuid, ${dataUrl}, ${media.fileName},
       ${media.buffer.length}, NULL)
  `;
  log.info('bankTxQueryReply: media attached to bank tx', {
    companyId, queryId: query.id, bankTransactionId: query.bankTransactionId,
    fileName: media.fileName, size: media.buffer.length,
  }, 'bank-tx-queries');
  return true;
}

export async function markQueryReplied(
  companyId: string,
  queryId: string,
  replyText: string | null,
  captureEventId: string | null,
): Promise<void> {
  await sql`
    UPDATE bank_tx_queries
    SET status = 'replied',
        replied_at = COALESCE(replied_at, NOW()),
        reply_text = LEFT(CASE
          WHEN ${replyText}::text IS NULL OR ${replyText} = '' THEN reply_text
          WHEN reply_text IS NULL THEN ${replyText}
          ELSE reply_text || E'\n' || ${replyText}
        END, 10000),
        reply_capture_event_id = COALESCE(reply_capture_event_id, ${captureEventId}::uuid),
        updated_at = NOW()
    WHERE id = ${queryId}::uuid
      AND company_id = ${companyId}::uuid
      AND status IN ('sent', 'replied')
  `;
  log.info('bankTxQueryReply: query marked replied', {
    companyId, queryId, hasText: Boolean(replyText), captureEventId,
  }, 'bank-tx-queries');
}
