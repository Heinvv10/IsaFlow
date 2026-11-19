/**
 * A file already on a bank line with the same bytes (sha256), whatever name it was stored under.
 *
 * A bank line's uploads are data URLs in bank_transaction_attachments.file_url, so the hash is computable in SQL from
 * what is stored: decode the base64 after the comma and sha256 it. Only the one line's rows are read (a line carries a
 * handful), fenced by the line's company, and only those whose stored size is the file's (or unrecorded): a different
 * size cannot be the same bytes, so it is never decoded. A row whose file_url is not a base64 data URL is skipped,
 * never an error. Returns the attachment (shaped as attach_document answers one), or null.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface BankLineShaMatch {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
}

export async function findBankLineShaDuplicate(
  companyId: string, bankTxId: string, sha256: string, size: number,
): Promise<BankLineShaMatch | null> {
  const [row] = (await sql`
    SELECT a.id, a.file_name, a.file_size, a.created_at, substring(a.file_url FROM '^data:([^;,]+)') AS mime_type
      FROM bank_transaction_attachments a
      JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
     WHERE a.bank_transaction_id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
       AND (a.file_size = ${size} OR a.file_size IS NULL)
       AND a.file_url ~ '^data:[^,]*;base64,[A-Za-z0-9+/=]*$'
       AND encode(sha256(decode(substring(a.file_url FROM position(',' IN a.file_url) + 1), 'base64')), 'hex') = ${sha256}
     ORDER BY a.created_at, a.id
     LIMIT 1
  `) as DbRow[];
  if (!row) return null;
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at);
  return {
    id: String(row.id),
    fileName: String(row.file_name ?? ''),
    fileSize: row.file_size == null ? size : Number(row.file_size),
    mimeType: row.mime_type == null ? 'application/octet-stream' : String(row.mime_type),
    createdAt: created,
  };
}
