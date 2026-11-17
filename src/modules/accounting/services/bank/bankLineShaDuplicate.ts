/**
 * A file already on a bank line with the same bytes (sha256), whatever name it was stored under.
 *
 * A bank line's uploads are data URLs in bank_transaction_attachments.file_url, so the hash is computable in SQL from
 * what is stored: decode the base64 after the comma and sha256 it. Only the one line's rows are read (a line carries a
 * handful), fenced by the line's company. A row whose file_url is not a base64 data URL is skipped, never an error.
 * Returns the attachment id, or null.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function findBankLineShaDuplicate(
  companyId: string, bankTxId: string, sha256: string,
): Promise<string | null> {
  const [row] = (await sql`
    SELECT a.id FROM bank_transaction_attachments a
      JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
     WHERE a.bank_transaction_id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
       AND a.file_url ~ '^data:[^,]*;base64,[A-Za-z0-9+/=]*$'
       AND encode(sha256(decode(substring(a.file_url FROM position(',' IN a.file_url) + 1), 'base64')), 'hex') = ${sha256}
     ORDER BY a.created_at, a.id
     LIMIT 1
  `) as DbRow[];
  return row ? String(row.id) : null;
}
