/**
 * A company's bank-line documents for the MCP list_documents tool: uploads (store 'bank_attachment') and captured
 * documents linked to a line with no copy there (store 'captured_document'), the same set the grid counts
 * (bank/bankLineDocumentSql). Moved out of documentQueryService, which re-exports it.
 *
 * Tenant fence: bank_transaction_attachments has no company_id, so it is reached through its bank line's company_id;
 * a captured document must also carry the line's own company_id.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { attachmentCountsSql, hasNoCopySql, linkedCapturedDocSql } from '../bank/bankLineDocumentSql';

export interface BankAttachmentRow {
  id: string;
  store: 'bank_attachment' | 'captured_document';
  bankTransactionId: string;
  fileName: string;
  fileSize: number;
  uploadedBy: string | null;
  createdAt: string;
  transactionDate: string;
  amount: number;
  transactionDescription: string;
  reference: string | null;
}

export interface AttachmentFilters {
  /** Transaction-date bounds. Both may be omitted when `bankTransactionId` names the line. */
  from?: string;
  to?: string;
  limit: number;
  bankTransactionId?: string;
}

export interface AttachmentPage {
  rows: BankAttachmentRow[];
  rowsTotal: number;
  postedThrough: string;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

export async function listBankAttachments(companyId: string, f: AttachmentFilters): Promise<AttachmentPage> {
  try {
    const txId = f.bankTransactionId ?? null;
    const from = f.from ?? null;
    const to = f.to ?? null;
    // One CTE for rows and count, so the two can never disagree about which documents exist.
    const docs = sql`
      WITH docs AS (
        SELECT a.id, 'bank_attachment'::text AS store, a.bank_transaction_id, a.file_name, a.file_size,
               a.uploaded_by, a.created_at
          FROM bank_transaction_attachments a
          JOIN bank_transactions bt ON bt.id = a.bank_transaction_id
         WHERE bt.company_id = ${companyId}::UUID
           AND (${from}::DATE IS NULL OR bt.transaction_date >= ${from}::DATE) AND (${to}::DATE IS NULL OR bt.transaction_date <= ${to}::DATE)
           AND (${txId}::TEXT IS NULL OR a.bank_transaction_id::TEXT = ${txId})
           AND ${sql.unsafe(attachmentCountsSql('a', 'bt'))}
        UNION ALL
        SELECT cd.id, 'captured_document'::text, bt.id, cd.file_name, COALESCE(cd.raw_bytes_size, cd.file_size),
               NULL::uuid, cd.created_at
          FROM captured_documents cd
          JOIN bank_transactions bt ON bt.id = cd.matched_bank_tx_id
         WHERE bt.company_id = ${companyId}::UUID
           AND (${from}::DATE IS NULL OR bt.transaction_date >= ${from}::DATE) AND (${to}::DATE IS NULL OR bt.transaction_date <= ${to}::DATE)
           AND (${txId}::TEXT IS NULL OR bt.id::TEXT = ${txId})
           AND ${sql.unsafe(linkedCapturedDocSql('bt', 'cd'))} AND ${sql.unsafe(hasNoCopySql('bt', 'cd'))}
      )`;
    const rows = (await sql`
      ${docs}
      SELECT d.*, bt.transaction_date, bt.amount, bt.description AS tx_description, bt.reference
        FROM docs d JOIN bank_transactions bt ON bt.id = d.bank_transaction_id
       ORDER BY d.created_at DESC, d.id DESC
       LIMIT ${f.limit}
    `) as DbRow[];
    const [count] = (await sql`${docs} SELECT COUNT(*) AS cnt, MAX(created_at) AS latest FROM docs`) as DbRow[];

    return {
      rows: rows.map((r) => ({
        id: String(r.id),
        store: r.store === 'captured_document' ? 'captured_document' : 'bank_attachment',
        bankTransactionId: String(r.bank_transaction_id),
        fileName: String(r.file_name ?? ''),
        fileSize: Number(r.file_size ?? 0),
        uploadedBy: r.uploaded_by != null ? String(r.uploaded_by) : null,
        createdAt: iso(r.created_at),
        transactionDate: fmtDate(r.transaction_date),
        amount: Number(r.amount ?? 0),
        transactionDescription: String(r.tx_description ?? ''),
        reference: r.reference != null ? String(r.reference) : null,
      })),
      rowsTotal: Number(count?.cnt ?? 0),
      postedThrough: count?.latest != null ? iso(count.latest) : new Date(0).toISOString(),
    };
  } catch (err) {
    log.error('Failed to list bank attachments', { companyId, error: err }, 'accounting');
    throw err;
  }
}
